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

// Closed alert groups for a SAST calendar range. One query returns the
// report rows plus linked NCR/cost-centre metadata; no per-row subqueries.
async function getClosedGroupsInRange({ from, to } = {}) {
  const fromDate = String(from || '').slice(0, 10);
  const toDate = String(to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return [];
  }
  const result = await query(
    `WITH closed AS (
       SELECT g.id, g.group_key, g.device_id, g.device_name, g.alarm_type,
              g.severity, g.count, g.source_type, g.last_alert_ts,
              g.fleet_number, g.resolved_at, g.updated_at,
              to_char(COALESCE(g.resolved_at, g.updated_at, g.last_alert_ts)
                      AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD"T"HH24:MI:SS') AS closed_sast,
              to_char(COALESCE(g.resolved_at, g.updated_at, g.last_alert_ts)
                      AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS closed_date
         FROM alert_groups g
        WHERE g.resolved = TRUE
          AND g.false_alert = FALSE
          AND COALESCE(g.resolved_at, g.updated_at, g.last_alert_ts) >= $1::date
          AND COALESCE(g.resolved_at, g.updated_at, g.last_alert_ts) < ($2::date + INTERVAL '1 day')
     ),
     alert_counts AS (
       SELECT alert_group_id, COUNT(*)::int AS member_count
         FROM alerts
        WHERE alert_group_id IN (SELECT id FROM closed)
        GROUP BY alert_group_id
     ),
     incident_meta AS (
       SELECT i.alert_group_key, MAX(i.cost_center_id) AS incident_cc_id
         FROM incidents i
        WHERE i.alert_group_key IN (SELECT group_key FROM closed)
        GROUP BY i.alert_group_key
     ),
     ncr_meta AS (
       SELECT i.alert_group_key,
              COUNT(nf.id)::int AS ncr_count,
              string_agg(nf.ncr_no, ', ' ORDER BY nf.created_at DESC) AS ncr_nos,
              (array_agg(i.id::text ORDER BY nf.created_at DESC))[1] AS ncr_incident_id
         FROM incidents i
         JOIN ncr_forms nf ON nf.incident_id = i.id
        WHERE i.alert_group_key IN (SELECT group_key FROM closed)
        GROUP BY i.alert_group_key
     )
     SELECT c.*,
            im.incident_cc_id,
            GREATEST(c.count, COALESCE(ac.member_count, 0))::int AS occurrence_count,
            COALESCE(nm.ncr_count, 0)::int AS ncr_count,
            nm.ncr_nos,
            nm.ncr_incident_id
       FROM closed c
       LEFT JOIN alert_counts ac ON ac.alert_group_id = c.id
       LEFT JOIN incident_meta im ON im.alert_group_key = c.group_key
       LEFT JOIN ncr_meta nm ON nm.alert_group_key = c.group_key
      ORDER BY COALESCE(c.resolved_at, c.updated_at, c.last_alert_ts) DESC, c.id DESC`,
    [fromDate, toDate]
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

// NCR register: every NCR form joined to its incident. Independent of
// alert_groups so the register survives an alert-history clear. Filters are
// applied in SQL so the total count stays consistent with the page.
async function getNcrRegister({ status, from, to, costCenterIds, q, pageSize = 50, pageIndex = 1 } = {}) {
  const conditions = [];
  const params = [];
  // Export callers ask for a large page to pull the whole register in one go;
  // keep the clamp high enough that it is not silently truncated.
  const limit = Math.min(Math.max(parseInt(pageSize) || 50, 1), 5000);
  const offset = (Math.max(parseInt(pageIndex) || 1, 1) - 1) * limit;

  // Cost-centre resolution, most authoritative source first:
  //   1. the vehicle's row in fleet_vehicles
  //   2. the cost centre stored on the incident
  //   3. the cost centre captured on the NCR form itself
  // Step 3 matters because plenty of NCRs are raised against fleet codes that
  // have no row in fleet_vehicles (e.g. TTW095, PLS246, TTW082). Without it
  // those rows show no cost centre even though the person filling in the form
  // picked one. cost_centers names are unique, so a name lookup is safe.
  const fleetCostCenterJoin = `LEFT JOIN LATERAL (
    SELECT cost_center_id, TRUE AS matched
      FROM fleet_vehicles
     WHERE UPPER(TRIM(fleet_number)) = UPPER(TRIM(i.fleet_number))
     ORDER BY cost_center_id NULLS LAST
     LIMIT 1
  ) fv ON TRUE`;

  const ncrFormCostCenterJoin = `LEFT JOIN cost_centers form_cc_by_id
       ON form_cc_by_id.id::text = nf.form_data->>'costCenterId'
      LEFT JOIN cost_centers form_cc_by_name
       ON lower(trim(form_cc_by_name.name)) = lower(trim(nf.form_data->>'costCenterName'))`;

  const costCenterIdSql = `COALESCE(fv.cost_center_id, i.cost_center_id, form_cc_by_id.id, form_cc_by_name.id)`;
  const costCenterNameSql = `COALESCE(fv_cc.name, cc.name, form_cc_by_id.name,
                                   NULLIF(TRIM(nf.form_data->>'costCenterName'), ''))`;

  // Workflow mapping:
  //   REVIEW -> Review
  //   CLOSED -> Closed
  //   everything else, including RESOLVED/SAVED -> Open
  const normalizedStatusSql = `CASE
    WHEN UPPER(TRIM(nf.status)) = 'REVIEW' THEN 'REVIEW'
    WHEN UPPER(TRIM(nf.status)) = 'CLOSED' THEN 'CLOSED'
    ELSE 'OPEN'
  END`;

  if (status) {
    const raw = String(status).trim().toUpperCase();
    if (raw === 'OPEN') {
      conditions.push(`${normalizedStatusSql} = 'OPEN'`);
    } else if (raw === 'REVIEW') {
      conditions.push(`${normalizedStatusSql} = 'REVIEW'`);
    } else if (raw === 'CLOSED') {
      conditions.push(`${normalizedStatusSql} = 'CLOSED'`);
    } else if (raw === 'NOT_CLOSED') {
      conditions.push(`${normalizedStatusSql} <> 'CLOSED'`);
    } else if (raw) {
      params.push(raw);
      conditions.push(`UPPER(TRIM(nf.status)) = $${params.length}`);
    }
  }

  const createdDateSql = `(nf.created_at AT TIME ZONE 'Africa/Johannesburg')::date`;
  if (from && to) {
    params.push(from, to);
    conditions.push(`${createdDateSql} BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
  } else if (from) {
    params.push(from);
    conditions.push(`${createdDateSql} >= $${params.length}::date`);
  } else if (to) {
    params.push(to);
    conditions.push(`${createdDateSql} <= $${params.length}::date`);
  }

  const ccList = String(costCenterIds || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (ccList.length > 0) {
    params.push(ccList);
    // Unassigned rows (no vehicle, no incident cost centre, nothing usable on
    // the form) are kept: they belong to no cost centre, so excluding them made
    // the register look incomplete even when every cost centre was selected.
    conditions.push(`(${costCenterIdSql} = ANY($${params.length}::int[])
                      OR ${costCenterIdSql} IS NULL)`);
  }

  if (q) {
    const like = `%${String(q).trim()}%`;
    params.push(like);
    conditions.push(`(nf.ncr_no ILIKE $${params.length} OR i.driver_name ILIKE $${params.length} OR i.fleet_number ILIKE $${params.length} OR i.incident_no ILIKE $${params.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
       FROM ncr_forms nf
       JOIN incidents i ON i.id = nf.incident_id
       ${fleetCostCenterJoin}
       ${ncrFormCostCenterJoin}
       ${where}`,
    params
  );

  const result = await query(
    `SELECT nf.id AS form_id, nf.ncr_no, nf.status AS form_status, nf.created_by_email,
            nf.created_at AS form_created_at, nf.updated_at AS form_updated_at,
            nf.closed_at,
            nf.form_data,
            i.id AS incident_id, i.incident_no, ${normalizedStatusSql} AS incident_status,
            to_char(i.incident_date, 'YYYY-MM-DD') AS incident_date,
            to_char(i.incident_time, 'HH24:MI') AS incident_time,
            i.alert_id, i.alarm_type, i.source_type,
            i.fleet_number, i.driver_name, i.contact_number,
            COALESCE(fv.matched, FALSE) AS vehicle_in_system,
            i.infringement, i.infringement_detail, i.action_taken, i.outcome, i.notes,
            ${costCenterIdSql} AS cost_center_id,
            i.closure_type, i.resolved_by,
            i.resolved_at, i.created_at AS incident_created_at,
            ${costCenterNameSql} AS cost_center_name
       FROM ncr_forms nf
       JOIN incidents i ON i.id = nf.incident_id
       LEFT JOIN cost_centers cc ON cc.id = i.cost_center_id
       ${fleetCostCenterJoin}
       LEFT JOIN cost_centers fv_cc ON fv_cc.id = fv.cost_center_id
       ${ncrFormCostCenterJoin}
       ${where}
      ORDER BY nf.created_at DESC, nf.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const rows = result.rows;
  if (rows.length > 0) {
    const formIds = [...new Set(rows.map((row) => row.form_id).filter(Boolean))];
    const incidentIds = [...new Set(rows.map((row) => row.incident_id).filter(Boolean))];
    const documents = await query(
      `SELECT id, ncr_form_id, incident_id, name
         FROM ncr_documents
        WHERE ncr_form_id = ANY($1::uuid[])
           OR (ncr_form_id IS NULL AND incident_id = ANY($2::uuid[]))
        ORDER BY created_at ASC, name ASC`,
      [formIds, incidentIds]
    );

    const byForm = new Map();
    const byIncident = new Map();
    for (const doc of documents.rows) {
      const name = String(doc.name || '').trim();
      if (!name) continue;
      const bucket = doc.ncr_form_id ? byForm : byIncident;
      const key = doc.ncr_form_id || doc.incident_id;
      if (!key) continue;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(name);
    }

    for (const row of rows) {
      const names = byForm.get(row.form_id) || byIncident.get(row.incident_id) || [];
      row.attached_docs = [...new Set(names)];
    }
  }

  return { rows, total: countResult.rows[0].total, page: parseInt(pageIndex) || 1, pageSize: limit };
}

module.exports = {
  getAllIncidents,
  getAllClosedGroups,
  getClosedGroupsInRange,
  getAllNcrForms,
  getNcrRegister,
  getCostCenters,
  getIncidentDocuments,
  insertIncidentDocument,
  deleteIncidentDocument,
};
