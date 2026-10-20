const { query } = require('./pool');

// ISO-8601 week number (1-53), matching Excel WEEKNUM-style week the register uses.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function incidentSelectColumns() {
  return `id, incident_no, alert_id, alert_group_key, alarm_type, source_type, device_id, fleet_number, cost_center_id,
    week, shift, incident_date, incident_time, controller, driver_name, contact_number, id_number, division,
    infringement, infringement_detail, action_taken, outcome, notes, document_link, document_type, status,
    filled_by, filled_at, resolved_by, resolved_at, closure_type, deduction_applied, created_at, updated_at`;
}

// Insert an incident captured from an alert (auto-NCR or manual close).
// Only the resolution + form fields are updated on conflict; the incident is always attached to one alert.
async function upsertIncidentFromAlert({
  alertId,
  alertGroupKey = null,
  alarmType = null,
  sourceType = 'telematics',
  deviceId = null,
  fleetNumber = null,
  costCenterId = null,
  filledBy = 'SYSTEM',
  status = 'OPEN',
  ...form
}) {
  const saveTime = new Date();
  const saveIso = saveTime.toISOString();

  // Fill-instead-of-duplicate: an auto-NCR row created earlier (SYSTEM, OPEN)
  // carries a different alert_id per threshold hit, so the alert_id conflict
  // never matches it. Match its group key while still OPEN and fill the human
  // data (driver, controller, doc, outcome) onto that same row.
  if (alertGroupKey) {
    const open = await query(
      `SELECT id FROM incidents WHERE alert_group_key = $1 AND status = 'OPEN' LIMIT 1`,
      [alertGroupKey]
    ).catch(() => ({ rows: [] }));
    if (open.rows.length > 0) {
      const oid = open.rows[0].id;
      const filled = await query(
        `UPDATE incidents SET
           alert_id = COALESCE(NULLIF($2, ''), alert_id),
           alarm_type = COALESCE(NULLIF($3, ''), alarm_type),
           controller = COALESCE(NULLIF($4, ''), controller),
           driver_name = COALESCE(NULLIF($5, ''), driver_name),
           contact_number = COALESCE(NULLIF($6, ''), contact_number),
           id_number = COALESCE(NULLIF($7, ''), id_number),
           division = COALESCE(NULLIF($8, ''), division),
           infringement = COALESCE(NULLIF($9, ''), infringement),
           infringement_detail = COALESCE(NULLIF($10, ''), infringement_detail),
           action_taken = COALESCE(NULLIF($11, ''), action_taken),
           outcome = COALESCE(NULLIF($12, ''), outcome),
           notes = COALESCE(NULLIF($13, ''), notes),
           document_link = COALESCE(NULLIF($14, ''), document_link),
           document_type = COALESCE(NULLIF($15, ''), document_type),
           status = COALESCE(NULLIF($16, ''), status),
           filled_by = COALESCE(NULLIF($17, ''), filled_by),
           updated_at = NOW()
         WHERE id = $1
         RETURNING ${incidentSelectColumns()}`,
        [oid, alertId, alarmType, form.controller || null, form.driver_name || null,
         form.contact_number || null, form.id_number || null, form.division || null,
         form.infringement || null, form.infringement_detail || null, form.action_taken || null,
         form.outcome || null, form.notes || null, form.document_link || null,
         form.document_type || null, status, filledBy]
      );
      if (filled.rows.length > 0) return filled.rows[0];
    }
  }

  const result = await query(
    `INSERT INTO incidents (
       incident_no, alert_id, alert_group_key, alarm_type, source_type, device_id, fleet_number, cost_center_id,
       week, shift, incident_date, incident_time, controller, driver_name, contact_number, id_number, division,
       infringement, infringement_detail, action_taken, outcome, notes, document_link, document_type,
       status, filled_by
     ) VALUES (
       DEFAULT, $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20, $21, $22, $23,
       $24, $25
     )
     ON CONFLICT (alert_id) DO UPDATE SET
       alert_group_key = COALESCE(EXCLUDED.alert_group_key, incidents.alert_group_key),
       alarm_type = COALESCE(EXCLUDED.alarm_type, incidents.alarm_type),
       source_type = COALESCE(EXCLUDED.source_type, incidents.source_type),
       device_id = COALESCE(EXCLUDED.device_id, incidents.device_id),
       fleet_number = COALESCE(EXCLUDED.fleet_number, incidents.fleet_number),
       cost_center_id = COALESCE(EXCLUDED.cost_center_id, incidents.cost_center_id),
       week = COALESCE(EXCLUDED.week, incidents.week),
       shift = COALESCE(EXCLUDED.shift, incidents.shift),
       incident_date = COALESCE(EXCLUDED.incident_date, incidents.incident_date),
       incident_time = COALESCE(EXCLUDED.incident_time, incidents.incident_time),
       controller = COALESCE(EXCLUDED.controller, incidents.controller),
       driver_name = COALESCE(EXCLUDED.driver_name, incidents.driver_name),
       contact_number = COALESCE(EXCLUDED.contact_number, incidents.contact_number),
       id_number = COALESCE(EXCLUDED.id_number, incidents.id_number),
       division = COALESCE(EXCLUDED.division, incidents.division),
       infringement = COALESCE(EXCLUDED.infringement, incidents.infringement),
       infringement_detail = COALESCE(EXCLUDED.infringement_detail, incidents.infringement_detail),
       action_taken = COALESCE(EXCLUDED.action_taken, incidents.action_taken),
       outcome = COALESCE(EXCLUDED.outcome, incidents.outcome),
       notes = COALESCE(EXCLUDED.notes, incidents.notes),
       document_link = COALESCE(EXCLUDED.document_link, incidents.document_link),
       document_type = COALESCE(EXCLUDED.document_type, incidents.document_type),
       status = COALESCE(EXCLUDED.status, incidents.status),
       filled_by = COALESCE(EXCLUDED.filled_by, incidents.filled_by),
       updated_at = NOW()
     RETURNING ${incidentSelectColumns()}`,
    [
      alertId,
      alertGroupKey,
      alarmType,
      sourceType,
      deviceId,
      fleetNumber,
      costCenterId,
      form.week || isoWeek(saveTime),
      form.shift || null,
      form.incident_date || (() => {
        // Convert UTC to SAST (UTC+2) for incident date
        const d = new Date(saveTime);
        d.setHours(d.getHours() + 2);
        return d.toISOString().slice(0, 10);
      })(),
      form.incident_time || (() => {
        // Convert UTC to SAST (UTC+2) for incident time
        const d = new Date(saveTime);
        d.setHours(d.getHours() + 2);
        return d.toISOString().slice(11, 16);
      })(),
      form.controller || null,
      form.driver_name || null,
      form.contact_number || null,
      form.id_number || null,
      form.division || null,
      form.infringement || null,
      form.infringement_detail || null,
      form.action_taken || null,
      form.outcome || null,
      form.notes || null,
      form.document_link || null,
      form.document_type || null,
      status,
      filledBy,
    ]
  );
  return result.rows[0] || null;
}

async function getIncidentByAlertId(alertId) {
  const result = await query(
    `SELECT ${incidentSelectColumns()} FROM incidents WHERE alert_id = $1`,
    [alertId]
  );
  return result.rows[0] || null;
}

async function getIncident(id) {
  const result = await query(
    `SELECT ${incidentSelectColumns()} FROM incidents WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getIncidents({ cost_center_id, cost_center_ids, fleet_number, status, from, to, pageSize = 50, pageIndex = 1 } = {}) {
  const conditions = [];
  const params = [];
  const limit = Math.min(Math.max(parseInt(pageSize) || 50, 1), 500);
  const offset = (Math.max(parseInt(pageIndex) || 1, 1) - 1) * limit;

  const ccList = String(cost_center_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (String(cost_center_id || '').trim()) ccList.push(String(cost_center_id).trim());
  if (ccList.length > 0) {
    const ccNums = [...new Set(ccList.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (ccNums.length > 0) {
      params.push(ccNums);
      conditions.push(`cost_center_id = ANY($${params.length}::int[])`);
    }
  }
  if (fleet_number) {
    params.push(String(fleet_number));
    conditions.push(`fleet_number = $${params.length}`);
  }
  if (status) {
    // Comma-separated statuses (e.g. RESOLVED,FALSE_ALERT for the closed tab).
    const statuses = String(status)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (statuses.length === 1) {
      params.push(statuses[0]);
      conditions.push(`status = $${params.length}`);
    } else if (statuses.length > 1) {
      params.push(statuses);
      conditions.push(`status = ANY($${params.length}::text[])`);
    }
  }
  if (from && to) {
    params.push(from, to);
    conditions.push(`incident_date BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (from) {
    params.push(from);
    conditions.push(`incident_date >= $${params.length}`);
  } else if (to) {
    params.push(to);
    conditions.push(`incident_date <= $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countResult = await query(`SELECT COUNT(*)::int AS total FROM incidents ${where}`, params);
  const result = await query(
    `SELECT ${incidentSelectColumns()} FROM incidents ${where}
     ORDER BY incident_date DESC NULLS LAST, created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return { incidents: result.rows, total: countResult.rows[0].total, page: parseInt(pageIndex) || 1, pageSize: limit };
}

async function updateIncidentFields(id, fields) {
  const allowed = [
    'week', 'shift', 'incident_date', 'incident_time', 'controller', 'driver_name', 'contact_number',
    'id_number', 'division', 'infringement', 'infringement_detail', 'action_taken', 'outcome', 'notes',
    'document_link', 'document_type', 'status', 'resolved_by', 'resolved_at', 'closure_type', 'deduction_applied'
  ];
  const sets = [];
  const params = [];
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) continue;
    params.push(fields[key]);
    sets.push(`${key} = $${params.length}`);
  }
  if (sets.length === 0) return null;
  params.push(id);
  sets.push('updated_at = NOW()');
  const result = await query(
    `UPDATE incidents SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${incidentSelectColumns()}`,
    params
  );
  return result.rows[0] || null;
}

module.exports = {
  upsertIncidentFromAlert,
  getIncidentByAlertId,
  getIncident,
  getIncidents,
  updateIncidentFields,
  incidentSelectColumns,
};