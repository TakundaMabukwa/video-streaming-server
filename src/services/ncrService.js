// NCR document store: saves the signed form, its evidence and the background
// jobs that finish the process (resolve + email). The save is deliberately
// FAST — the user must never wait for a PDF, an email or a group closure.
const db = require('../db');
const { findVehicleCostCenterId } = require('./costCenterLookup');

const ALERT_FORM_KEYS = [
  'ncrNo', 'driverId', 'driverName', 'contactNumber', 'idNumber', 'idDocumentType',
  'department', 'section', 'responsibleManager', 'manager', 'investigator',
  'vehicleFleetNumber', 'vehicleRegistration', 'costCenterId', 'costCenterName',
  'date', 'time', 'duration',
  'area', 'site', 'location', 'alertId', 'lastOccurrence', 'alertType',
  'alertSeverity', 'classifications', 'otherClassification', 'description',
  'riskRating', 'rootCauses', 'correctiveAction', 'correctiveResponsibility',
  'correctiveTargetDate', 'outcome', 'preventiveAction', 'preventiveResponsibility',
  'preventiveTargetDate', 'probability', 'ratingMatrix', 'actions',
  'evidenceCount', 'attachments', 'notes',
];

// Human-readable cost-centre name for the stored document (best effort).
async function findCostCenterName(costCenterId) {
  if (costCenterId == null) return null;
  const { rows } = await db.query('SELECT name FROM cost_centers WHERE id = $1 LIMIT 1', [costCenterId]);
  return rows[0]?.name || null;
}

/**
 * Persist an NCR document for an alert group.
 *
 * The creator is mandatory and comes from the VERIFIED session (req.user),
 * never from the payload and never a placeholder — an NCR must always be
 * attributable to a real person.
 *
 * @param {object} opts
 * @param {number|string} opts.groupId     alert_groups.id
 * @param {object} opts.form               the document fields (as displayed)
 * @param {Array}  [opts.evidence]        [{ url, type, channel, alertId, capturedAt }]
 * @param {{id?: string, email: string}} opts.actor  the signed-in user
 * @param {boolean} [opts.archive]         build + link the evidence ZIP
 * @returns {Promise<{ok: boolean, error?: string, ncrFormId?: string, incidentId?: string}>}
 */
async function createNcrFromAlert(opts = {}) {
  const { groupId: rawGroupId, form = {}, evidence = [], actor = null, archive = false } = opts;
  const groupId = Number(rawGroupId);
  if (!Number.isInteger(groupId) || groupId < 1) {
    return { ok: false, error: 'groupId must be alert_groups.id (integer)' };
  }

  const actorEmail = String(actor?.email || '').trim();
  const actorId = actor?.id ? String(actor.id) : null;
  if (!actorEmail) {
    return {
      ok: false,
      status: 422,
      error: 'The signed-in account has no email address, so the NCR cannot be attributed. Sign in with an account that has an email.',
    };
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
  formData.createdByEmail = actorEmail;
  formData.createdById = actorId;

  const fleetNumber = String(
    formData.vehicleFleetNumber || formData.fleetNumber || group.fleet_number || group.device_id || ''
  ).trim();
  const costCenterId = await findVehicleCostCenterId(fleetNumber).catch(() => null);
  // Always keep the vehicle's cost centre on the stored document too, not only
  // on the incident row. When the id resolves, the authoritative name wins.
  formData.costCenterId = costCenterId == null ? null : costCenterId;
  if (costCenterId != null) {
    const resolvedCostCenterName = await findCostCenterName(costCenterId).catch(() => null);
    if (resolvedCostCenterName) formData.costCenterName = resolvedCostCenterName;
  }

  const now = new Date().toISOString();
  const incident = await db.upsertIncidentFromAlert({
    alertId: group.last_alert_id || String(groupId),
    alertGroupKey: group.group_key,
    alarmType: group.alarm_type,
    sourceType: group.source_type || 'telematics',
    deviceId: group.device_id,
    fleetNumber,
    costCenterId,
    filledBy: actorEmail,
    status: 'OPEN',
    controller: actorEmail,
    driver_name: formData.driverName || null,
    contact_number: formData.contactNumber || null,
    id_number: formData.idNumber || null,
    division: [formData.department, formData.section].filter(Boolean).join(' - ') || null,
    infringement: (formData.classifications || []).join(', ') || group.alarm_type,
    infringement_detail: formData.description || null,
    action_taken: formData.correctiveAction || null,
    outcome: formData.outcome || formData.preventiveAction || null,
    notes: formData.notes || null,
    filled_at: now,
  });
  if (!incident) return { ok: false, error: 'Could not create the incident register row' };

  // One NCR per incident: a second save UPDATES the stored document instead
  // of failing on the unique index.
  const inserted = await db.query(
    `INSERT INTO ncr_forms
       (incident_id, ncr_no, alert_id, alert_group_id, alert_group_key, form_data, status,
        created_by, created_by_id, created_by_email)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'SAVED', $7, $8, $9)
     ON CONFLICT (incident_id) DO UPDATE
       SET form_data = EXCLUDED.form_data,
           ncr_no = COALESCE(EXCLUDED.ncr_no, ncr_forms.ncr_no),
           alert_id = EXCLUDED.alert_id,
           alert_group_id = EXCLUDED.alert_group_id,
           alert_group_key = COALESCE(EXCLUDED.alert_group_key, ncr_forms.alert_group_key),
           created_by = EXCLUDED.created_by,
           created_by_id = EXCLUDED.created_by_id,
           created_by_email = EXCLUDED.created_by_email,
           updated_at = NOW()
     RETURNING id, incident_id, ncr_no, status, archive_url, archive_status,
               (xmax = 0) AS inserted`,
    [
      incident.id,
      formData.ncrNo || null,
      group.last_alert_id || null,
      groupId,
      group.group_key || null,
      JSON.stringify(formData),
      actorEmail,
      actorId,
      actorEmail,
    ]
  );
  const ncrFormId = inserted.rows[0]?.id;
  if (!ncrFormId) return { ok: false, error: 'Could not store the NCR form' };
  const isNew = inserted.rows[0]?.inserted === true;

  // The evidence is replaced, not appended: a re-save shows exactly what the
  // document was saved with.
  await db.query('DELETE FROM ncr_evidence WHERE ncr_form_id = $1', [ncrFormId]);
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

  // Background work: close the group (first save only — a re-save must not
  // close again or deduct twice). The escalation email is dispatched by the
  // client after this returns.
  if (isNew) {
    await db.query(
      `INSERT INTO jobs (job_type, payload, ncr_form_id, incident_id, alert_group_id)
       VALUES ('resolve', $1::jsonb, $2, $3, $4)`,
      [
        JSON.stringify({
          userId: actorEmail,
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
            outcome: formData.outcome || formData.preventiveAction || null,
          },
          incidentId: incident.id,
        }),
        ncrFormId,
        incident.id,
        groupId,
      ]
    ).catch(() => {});
    // Close the alert group now, not on the next 15s poll: the caller expects
    // the alert resolved within seconds of the save returning.
    require('./jobRunner').kick();
  }

  if (archive) {
    const { queueArchiveForForm } = require('./incidentArchiveService');
    await queueArchiveForForm(ncrFormId, groupId, { requestedBy: actorEmail }).catch((err) => {
      console.error('[NCR] archive queue failed:', err.message);
    });
    require('./jobRunner').kick();
  }

  return {
    ok: true,
    ncrFormId,
    incidentId: incident.id,
    ncrNo: inserted.rows[0]?.ncr_no || formData.ncrNo || null,
    updated: !isNew,
    creatorEmail: actorEmail,
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
    error: form.error,
    created_by: form.created_by,
    created_by_id: form.created_by_id,
    created_by_email: form.created_by_email,
    created_at: form.created_at,
    updated_at: form.updated_at,
    archive_url: form.archive_url || null,
    archive_status: form.archive_status || null,
    archive_error: form.archive_error || null,
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
