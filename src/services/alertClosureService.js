// Alert-group closure — the shared path used by BOTH the HTTP close route and
// the background job runner, so a queued NCR closure behaves exactly like a
// manual one. The logic was moved verbatim out of dbAlertController.resolveAlert.
const db = require('../db');
const { resolveFleetNumber } = require('./costCenterLookup');
const { findVehicleCostCenterId } = require('./costCenterLookup');
const { applyNcrDeduction } = require('./driverScoringService');

let wsBroadcast = null;
function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

/**
 * Close an alert group (and its member detections), optionally filing the
 * incident register row and applying the NCR deduction.
 *
 * @param {object} opts
 * @param {number|string} opts.groupId      alert_groups.id
 * @param {string} [opts.userId]
 * @param {string} [opts.notes]
 * @param {'resolved'|'false_alert'|'ncr'} [opts.closureType]
 * @param {Array} [opts.documents]         [{ type, link, timestamp, filled_by }]
 * @param {string} [opts.action_taken]
 * @param {string} [opts.ncr_classification]
 * @param {string} [opts.close_reason]
 * @param {string} [opts.reported_by]
 * @param {object} [opts.incident]         register row fields
 * @param {string} [opts.incidentId]       pre-created incident id (NCR flow)
 * @returns {Promise<{ok: boolean, error?: string, result?: object}>}
 */
async function closeAlertGroup(opts = {}) {
  const {
    groupId: rawGroupId,
    userId,
    notes,
    closureType = 'resolved',
    documents: docData,
    action_taken,
    ncr_classification,
    close_reason,
    reported_by,
    incident: incidentData = {},
    incidentId = null,
  } = opts;

  const groupId = Number(rawGroupId);
  if (!Number.isInteger(groupId) || groupId < 1) {
    return { ok: false, error: 'Alert id must be alert_groups.id (integer)' };
  }

  const isFalse = closureType === 'false_alert';
  const now = new Date().toISOString();

  const group = await db.getAlertGroupById(groupId);
  if (!group) return { ok: false, error: `Alert group ${groupId} not found` };

  const resolved = await db.resolveAlertGroupById(groupId, {
    resolved: true,
    false_alert: isFalse,
    resolved_by: userId || null,
    resolved_at: now,
    notes: notes || null,
  });
  if (!resolved) return { ok: false, error: `Alert group ${groupId} not found` };

  const targetDeviceId = group.device_id;
  const targetAlarmType = group.alarm_type;
  const resolvedGroupKey = group.group_key;

  const docs = [];
  if (docData) {
    const docEntries = Array.isArray(docData) ? docData : [docData];
    for (const d of docEntries) {
      if (d && d.type && d.link) {
        docs.push({
          type: d.type,
          timestamp: d.timestamp || now,
          filled_by: d.filled_by || userId || 'unknown',
          link: d.link,
        });
      }
    }
    if (docs.length > 0) {
      const nextDocs = [...(Array.isArray(group.documents) ? group.documents : []), ...docs];
      await db.resolveAlertGroupById(groupId, { documents: nextDocs });
    }
  }

  const isNcr = String(group.alarm_type || '').startsWith('NCR:')
    || closureType === 'ncr'
    || !!(incidentData.infringement || ncr_classification || close_reason || action_taken);

  let incident = null;
  let deduction = { deducted: false };

  if (isNcr) {
    const fleetNumber = String(incidentData.fleet_number || incidentData.fleetNumber || '').trim()
      || (await resolveFleetNumber({
        deviceId: group.device_id,
        vehicleRegistration: group.device_name,
        fleetNumber: null,
      }).catch(() => null))
      || group.device_id;

    const costCenterId = await findVehicleCostCenterId(fleetNumber).catch(() => null);

    if (incidentId) {
      // The NCR flow created the register row up-front (fast save) — fill it in
      // here instead of creating a second one.
      incident = await db.updateIncidentFields(incidentId, {
        alert_id: group.last_alert_id || String(groupId),
        alert_group_key: resolvedGroupKey,
        alarm_type: group.alarm_type,
        source_type: group.source_type || 'telematics',
        device_id: group.device_id,
        fleet_number: fleetNumber,
        cost_center_id: costCenterId,
        filled_by: userId || 'SYSTEM',
        controller: reported_by || incidentData.controller || incidentData.reported_by || null,
        driver_name: incidentData.driver_name || incidentData.driverName || incidentData['name & surname'] || null,
        contact_number: incidentData.contact_number || incidentData.contactNumber || null,
        id_number: incidentData.id_number || null,
        division: incidentData.division || null,
        infringement: ncr_classification || incidentData.infringement || group.alarm_type,
        infringement_detail: close_reason || incidentData.infringement_detail || notes || null,
        action_taken: action_taken || incidentData.action_taken || null,
        outcome: incidentData.outcome || null,
        notes: notes || null,
      });
    }

    if (!incident) {
      incident = await db.upsertIncidentFromAlert({
        alertId: group.last_alert_id || String(groupId),
        alertGroupKey: resolvedGroupKey,
        alarmType: group.alarm_type,
        sourceType: group.source_type || 'telematics',
        deviceId: group.device_id,
        fleetNumber,
        costCenterId,
        filledBy: userId || 'SYSTEM',
        status: isFalse ? 'FALSE_ALERT' : 'OPEN',
        controller: reported_by || incidentData.controller || incidentData.reported_by || null,
        driver_name:
          incidentData.driver_name
          || incidentData.driverName
          || incidentData['name & surname']
          || null,
        contact_number: incidentData.contact_number || incidentData.contactNumber || null,
        id_number: incidentData.id_number || null,
        division: incidentData.division || null,
        infringement: ncr_classification || incidentData.infringement || group.alarm_type,
        infringement_detail: close_reason || incidentData.infringement_detail || notes || null,
        action_taken: action_taken || incidentData.action_taken || null,
        outcome: incidentData.outcome || null,
        notes: notes || null,
        document_link: docs.length > 0 ? docs[0].link : null,
        document_type: docs.length > 0 ? docs[0].type : null,
      });
    }

    if (incident) {
      if (isFalse) {
        await db.updateIncidentFields(incident.id, { status: 'FALSE_ALERT', closure_type: closureType });
      } else {
        try {
          deduction = await applyNcrDeduction(fleetNumber, group.alarm_type);
        } catch (deductErr) {
          console.error('[AlertClosure] NCR deduction error:', deductErr.message);
        }
        const resFields = {
          status: 'RESOLVED',
          resolved_by: userId || null,
          resolved_at: now,
          closure_type: closureType,
        };
        if (deduction.deducted) resFields.deduction_applied = deduction.weighting;
        await db.updateIncidentFields(incident.id, resFields);
      }
    }
  }

  const result = {
    success: true,
    alertId: String(groupId),
    groupId,
    action: 'close',
    closureType,
    resolved: true,
    false_alert: isFalse,
    documents: docs,
    incident: incident || null,
    deduction,
    count: Number(group.count) || 1,
    group_key: resolvedGroupKey,
    message: `Alert group ${groupId} resolved`,
  };

  if (wsBroadcast) {
    wsBroadcast('alert-status-changed', {
      alert: {
        id: String(groupId),
        alert_id: String(groupId),
        status: 'resolved',
        resolved: true,
        false_alert: isFalse,
        resolved_by: userId || null,
        group_key: resolvedGroupKey,
        device_id: targetDeviceId || null,
        alert_type: targetAlarmType || null,
      },
    });
  }

  return { ok: true, result };
}

module.exports = { closeAlertGroup, setWsBroadcast };
