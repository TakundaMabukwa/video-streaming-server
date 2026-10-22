// NCR document store: saves the signed form, its evidence and the background
// jobs that finish the process (resolve + email). The save is deliberately
// FAST — the user must never wait for a PDF, an email or a group closure.
const db = require('../db');
const { findVehicleCostCenterId } = require('./costCenterLookup');

const ALERT_FORM_KEYS = [
  'ncrNo', 'driverName', 'contactNumber', 'idNumber', 'idDocumentType',
  'department', 'section', 'responsibleManager', 'manager', 'investigator',
  'vehicleFleetNumber', 'vehicleRegistration', 'date', 'time', 'duration',
  'area', 'site', 'location', 'alertId', 'lastOccurrence', 'alertType',
  'alertSeverity', 'classifications', 'otherClassification', 'description',
  'riskRating', 'rootCauses', 'correctiveAction', 'correctiveResponsibility',
  'correctiveTargetDate', 'preventiveAction', 'preventiveResponsibility',
  'preventiveTargetDate', 'probability', 'ratingMatrix', 'actions',
  'evidenceCount', 'attachments',
];

/**
 * Persist an NCR document for an alert group.
 *
 * @param {object} opts
 * @param {number|string} opts.groupId     alert_groups.id
 * @param {object} opts.form               the document fields (as displayed)
 * @param {Array}  [opts.evidence]        [{ url, type, channel, alertId, capturedAt }]
 * @param {string} [opts.userId]
 * @returns {Promise<{ok: boolean, error?: string, ncrFormId?: string, incidentId?: string}>}
 */
async function createNcrFromAlert(opts = {}) {
  const { groupId: rawGroupId, form = {}, evidence = [], userId = null } = opts;
  const groupId = Number(rawGroupId);
  if (!Number.isInteger(groupId) || groupId < 1) {
    return { ok: false, error: 'groupId must be alert_groups.id (integer)' };
  }

  const group = await db.getAlertGroupById(groupId);
  if (!group) return { ok: false, error: `Alert group ${groupId} not found` };

  // Keep only the known document keys — the payload may carry extra context.
  const formData = {};
  for (const key of ALERT_FORM_KEYS) {
    if (form[key] !== undefined) formData[key] = form[key];
  }
  formData.savedAt = new Date().toISOString();
  formData.alertType = formData.alertType || group.alarm_type || null;
  formData.fleetNumber = formData.vehicleFleetNumber || group.fleet_number || null;

  const fleetNumber = String(
    formData.vehicleFleetNumber || formData.fleetNumber || group.fleet_number || group.device_id || ''
  ).trim();
  const costCenterId = await findVehicleCostCenterId(fleetNumber).catch(() => null);

  const now = new Date().toISOString();
  const incident = await db.upsertIncidentFromAlert({
    alertId: group.last_alert_id || String(groupId),
    alertGroupKey: group.group_key,
    alarmType: group.alarm_type,
    sourceType: group.source_type || 'telematics',
    deviceId: group.device_id,
    fleetNumber,
    costCenterId,
    filledBy: userId || 'SYSTEM',
    status: 'OPEN',
    controller: userId || null,
    driver_name: formData.driverName || null,
    contact_number: formData.contactNumber || null,
    id_number: formData.idNumber || null,
    division: [formData.department, formData.section].filter(Boolean).join(' - ') || null,
    infringement: (formData.classifications || []).join(', ') || group.alarm_type,
    infringement_detail: formData.description || null,
    action_taken: formData.correctiveAction || null,
    outcome: formData.preventiveAction || null,
    notes: formData.notes || null,
    filled_at: now,
  });
  if (!incident) return { ok: false, error: 'Could not create the incident register row' };

  const ncr = await db.query(
    `INSERT INTO ncr_forms
       (incident_id, ncr_no, alert_id, alert_group_id, alert_group_key, form_data, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'SAVED', $7)
     RETURNING id, incident_id, ncr_no, status`,
    [
      incident.id,
      formData.ncrNo || null,
      group.last_alert_id || null,
      groupId,
      group.group_key || null,
      JSON.stringify(formData),
      userId,
    ]
  );
  const ncrFormId = ncr.rows[0]?.id;
  if (!ncrFormId) return { ok: false, error: 'Could not create the NCR form' };

  for (const item of evidence || []) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    await db.query(
      `INSERT INTO ncr_evidence (ncr_form_id, alert_id, file_url, file_type, channel, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ncrFormId,
        item.alertId || group.last_alert_id || null,
        url,
        item.type || item.fileType || null,
        Number.isFinite(Number(item.channel)) ? Number(item.channel) : null,
        item.capturedAt || null,
      ]
    ).catch(() => {});
  }

  // Background work: close the group, send the escalation email. Neither
  // blocks the user's save.
  await db.query(
    `INSERT INTO jobs (job_type, payload, ncr_form_id, incident_id, alert_group_id)
     VALUES ('resolve', $1::jsonb, $2, $3, $4)`,
    [
      JSON.stringify({
        userId,
        closureType: 'ncr',
        notes: formData.description || null,
        incident: {
          fleet_number: fleetNumber,
          driver_name: formData.driverName || null,
          contact_number: formData.contactNumber || null,
          id_number: formData.idNumber || null,
          division: [formData.department, formData.section].filter(Boolean).join(' - ') || null,
          infringement: (formData.classifications || []).join(', ') || null,
          infringement_detail: formData.description || null,
          action_taken: formData.correctiveAction || null,
          outcome: formData.preventiveAction || null,
        },
        incidentId: incident.id,
      }),
      ncrFormId,
      incident.id,
      groupId,
    ]
  ).catch(() => {});

  return {
    ok: true,
    ncrFormId,
    incidentId: incident.id,
    ncrNo: ncr.rows[0]?.ncr_no || formData.ncrNo || null,
  };
}

/** The stored document for the register (read-only view). */
async function getNcrForm(formId) {
  const { rows } = await db.query(
    `SELECT n.*, i.incident_no, i.status AS incident_status, i.fleet_number AS incident_fleet,
            i.driver_name AS incident_driver, i.resolved_by, i.resolved_at, i.closure_type
     FROM ncr_forms n
     LEFT JOIN incidents i ON i.id = n.incident_id
     WHERE n.id = $1`,
    [formId]
  );
  if (rows.length === 0) return null;
  const form = rows[0];
  const evidence = await db.query(
    `SELECT id, alert_id, file_url, file_type, channel, captured_at
     FROM ncr_evidence WHERE ncr_form_id = $1 ORDER BY id ASC`,
    [formId]
  );
  return {
    id: form.id,
    incident_id: form.incident_id,
    ncr_no: form.ncr_no,
    alert_id: form.alert_id,
    alert_group_id: form.alert_group_id,
    form_data: form.form_data || {},
    document_path: form.document_path,
    document_status: form.document_status,
    status: form.status,
    created_by: form.created_by,
    created_at: form.created_at,
    evidence: evidence.rows || [],
  };
}

/** The stored document for an incident (register lookup by incident id). */
async function getNcrFormByIncident(incidentId) {
  const { rows } = await db.query('SELECT id FROM ncr_forms WHERE incident_id = $1 LIMIT 1', [incidentId]);
  if (rows.length === 0) return null;
  return getNcrForm(rows[0].id);
}

/** Record the PDF the client rendered in the background. */
async function attachDocument(formId, documentPath) {
  const { rows } = await db.query(
    `UPDATE ncr_forms
     SET document_path = $2, document_status = 'RENDERED', updated_at = NOW()
     WHERE id = $1 RETURNING id, document_path, document_status`,
    [formId, documentPath]
  );
  if (rows.length === 0) return null;
  await db.query(
    `UPDATE incidents SET document_link = $2, document_type = 'ncr' WHERE id = $1`,
    [rows[0].id ? (await db.query('SELECT incident_id FROM ncr_forms WHERE id = $1', [formId])).rows[0]?.incident_id : null, documentPath]
  ).catch(() => {});
  return rows[0];
}

module.exports = { createNcrFromAlert, getNcrForm, getNcrFormByIncident, attachDocument, ALERT_FORM_KEYS };
