// Reports data access — the READ side of the incident register, the
// cost-centre statistics and the driver statistics.
//
// Nothing here filters by cost centre, date, status or "has NCR": the
// frontend owns every filter so a row can never disappear because of a
// server-side WHERE clause.
const { query } = require('./pool');

// Every incident, with the alert group's device name attached (the plate
// lives in the group name) and the NCR/document counts. Orphan incidents
// (their alert group was cleared) are kept — the register must show all data.
async function getAllIncidents() {
  const result = await query(
    `     WITH gk AS (
       SELECT group_key, device_name, device_id, fleet_number, count AS alert_count
         FROM alert_groups
     ),
     gi AS (
       SELECT id::text AS aid, device_name, device_id, fleet_number, count AS alert_count
         FROM alert_groups
     )
     SELECT i.id, i.incident_no, i.status,
            to_char(i.incident_date, 'YYYY-MM-DD') AS incident_date,
            to_char(i.incident_time, 'HH24:MI') AS incident_time,
            i.alert_id, i.alert_group_key, i.alarm_type, i.source_type,
            i.device_id, i.fleet_number, i.driver_name, i.id_number,
            i.contact_number, i.division, i.infringement, i.infringement_detail,
            i.action_taken, i.outcome, i.notes, i.controller, i.resolved_by,
            i.resolved_at, i.closure_type, i.cost_center_id,
            to_char(i.created_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_sast,
            COALESCE(gk.device_name, gi.device_name) AS device_name,
            COALESCE(gk.fleet_number, gi.fleet_number) AS group_fleet,
            (gk.group_key IS NOT NULL OR gi.aid IS NOT NULL) AS has_alert_group,
            COALESCE(gk.alert_count, gi.alert_count, 0)::int AS alert_count,
            (SELECT count(*) FROM ncr_forms nf WHERE nf.incident_id = i.id)::int AS ncr_count,
            (SELECT count(*) FROM ncr_documents nd WHERE nd.incident_id = i.id)::int AS doc_count,
            (SELECT string_agg(nf.ncr_no, ', ' ORDER BY nf.created_at DESC)
               FROM ncr_forms nf WHERE nf.incident_id = i.id) AS ncr_nos,
            (SELECT string_agg(nf.id::text, ', ' ORDER BY nf.created_at DESC)
               FROM ncr_forms nf WHERE nf.incident_id = i.id) AS ncr_form_ids
       FROM incidents i
       LEFT JOIN gk ON gk.group_key = i.alert_group_key
       LEFT JOIN gi ON gi.aid = i.alert_id
      ORDER BY COALESCE(i.incident_date, i.created_at::date) DESC NULLS LAST, i.created_at DESC`
  );
  return result.rows;
}

// Every closed (resolved, not false-alert) alert group — the rows behind the
// "Closed Alerts" count and the cost-centre cards. The NCR link is joined in
// the service layer from the incidents set (one query each, not a correlated
// subquery per group).
async function getAllClosedGroups() {
  const result = await query(
    `SELECT g.id, g.group_key, g.device_id, g.device_name, g.alarm_type,
            g.severity, g.count, g.source_type, g.last_alert_ts, g.fleet_number,
            g.resolved_at, g.updated_at,
            to_char(COALESCE(g.resolved_at, g.updated_at, g.last_alert_ts)
                    AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD"T"HH24:MI:SS') AS closed_sast,
            to_char(COALESCE(g.resolved_at, g.updated_at, g.last_alert_ts)
                    AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS closed_date
       FROM alert_groups g
      WHERE g.resolved = TRUE AND g.false_alert = FALSE`
  );
  return result.rows;
}

// Every stored NCR document (for the document lists + driver drill-down).
async function getAllNcrForms() {
  const result = await query(
    `SELECT nf.id, nf.incident_id, nf.ncr_no, nf.status, nf.document_path,
            nf.document_status, nf.archive_url, nf.archive_status,
            nf.created_by_email, nf.created_at, nf.updated_at,
            nf.form_data
       FROM ncr_forms nf`
  );
  return result.rows;
}

// Cost centres (the card grid) — the same source the top-nav dropdown uses.
async function getCostCenters() {
  const result = await query(
    `SELECT cc.id, cc.name, cc.code, cc.is_active,
            (SELECT count(*) FROM fleet_vehicles fv WHERE fv.cost_center_id = cc.id)::int AS vehicles
       FROM cost_centers cc
      ORDER BY cc.name`
  );
  return result.rows;
}

// Linked documents for one incident (or one NCR form).
async function getIncidentDocuments(incidentId) {
  const result = await query(
    `SELECT nd.id, nd.incident_id, nd.ncr_form_id, nd.name, nd.storage_path,
            nd.content_type, nd.byte_size, nd.doc_type, nd.uploaded_by, nd.created_at
       FROM ncr_documents nd
      WHERE nd.incident_id = $1
      ORDER BY nd.created_at DESC`,
    [incidentId]
  );
  return result.rows;
}

async function insertIncidentDocument(row) {
  const result = await query(
    `INSERT INTO ncr_documents
       (incident_id, ncr_form_id, name, storage_path, content_type, byte_size, doc_type, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, incident_id, ncr_form_id, name, storage_path, content_type,
               byte_size, doc_type, uploaded_by, created_at`,
    [
      row.incident_id || null,
      row.ncr_form_id || null,
      row.name,
      row.storage_path,
      row.content_type || null,
      row.byte_size == null ? null : Number(row.byte_size),
      row.doc_type || null,
      row.uploaded_by || null,
    ]
  );
  return result.rows[0] || null;
}

async function deleteIncidentDocument(id) {
  const result = await query(
    `DELETE FROM ncr_documents WHERE id = $1 RETURNING storage_path`,
    [id]
  );
  return result.rows[0] || null;
}

module.exports = {
  getAllIncidents,
  getAllClosedGroups,
  getAllNcrForms,
  getCostCenters,
  getIncidentDocuments,
  insertIncidentDocument,
  deleteIncidentDocument,
};
