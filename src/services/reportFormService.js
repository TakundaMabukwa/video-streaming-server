// Data-only report forms (incident, accident, criminal, dispatch).
//
// Saving is intentionally dumb: store the submitted form snapshot exactly.
// No PDF, no storage upload, no lookups, no recalculation and no incident
// upsert. Metadata is kept in separate columns so form_data never changes.
const { query } = require('../db/pool');
const linkage = require('./reportLinkage');

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function text(value) {
  return String(value || '').trim();
}

async function saveReportForm(input = {}, actor = null) {
  const form = cloneObject(input.form);
  const reportType = text(input.reportType || input.report_type || 'report');
  if (!reportType) throw Object.assign(new Error('reportType is required'), { status: 400 });

  const alertGroupId = toInt(input.alertGroupId ?? input.alert_group_id);
  const alertId = text(input.alertId ?? input.alert_id) || null;
  const alertGroupKey = text(input.alertGroupKey ?? input.alert_group_key) || null;
  const driverId = toInt(input.driverId ?? input.driver_id);
  const driverName = text(input.driverName ?? input.driver_name ?? form.driverName ?? form.driver_name ?? form.personsInvolved);
  const fleetNumber = text(input.fleetNumber ?? input.fleet_number ?? form.vehicleFleetNumber ?? form.fleet_number);
  const registration = text(input.registration ?? form.vehicleRegistration ?? form.registration);
  const costCenterId = toInt(input.costCenterId ?? input.cost_center_id ?? form.costCenterId ?? form.cost_center_id);
  const metadata = {
    ...cloneObject(input.metadata),
    submittedAt: new Date().toISOString(),
    actorEmail: text(actor?.email) || null,
    actorId: actor?.id == null ? null : String(actor.id),
  };
  const actorEmail = text(actor?.email) || null;
  const actorId = actor?.id == null ? null : String(actor.id);

  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const result = await query(
    `INSERT INTO report_forms
       (report_type, alert_id, alert_group_id, alert_group_key, driver_id, driver_name,
        vehicle_fleet_number, vehicle_registration, cost_center_id, form_data, metadata,
        created_by, created_by_id, created_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)
     ON CONFLICT (alert_group_id, report_type) WHERE alert_group_id IS NOT NULL
     DO UPDATE SET
       alert_id = COALESCE(EXCLUDED.alert_id, report_forms.alert_id),
       alert_group_key = COALESCE(EXCLUDED.alert_group_key, report_forms.alert_group_key),
       driver_id = EXCLUDED.driver_id,
       driver_name = EXCLUDED.driver_name,
       vehicle_fleet_number = EXCLUDED.vehicle_fleet_number,
       vehicle_registration = EXCLUDED.vehicle_registration,
       cost_center_id = EXCLUDED.cost_center_id,
       form_data = EXCLUDED.form_data,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, report_no, report_type, alert_group_id, created_at, updated_at,
               (xmax = 0) AS inserted`,
    [
      reportType,
      alertId,
      alertGroupId,
      alertGroupKey,
      driverId,
      driverName || null,
      fleetNumber || null,
      registration || null,
      costCenterId,
      JSON.stringify(form),
      JSON.stringify(metadata),
      actorEmail,
      actorId,
      actorEmail,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Could not store the report form');

  await query('DELETE FROM report_evidence WHERE report_form_id = $1', [row.id]);
  for (const item of evidence) {
    const url = text(item?.url ?? item?.file_url);
    if (!url) continue;
    await query(
      `INSERT INTO report_evidence (report_form_id, alert_id, file_url, file_type, channel, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.id,
        text(item?.alertId ?? item?.alert_id) || alertId,
        url,
        text(item?.type ?? item?.file_type) || null,
        toInt(item?.channel),
        item?.capturedAt ?? item?.captured_at ?? null,
      ]
    ).catch(() => {});
  }

  return {
    id: row.id,
    reportNo: row.report_no,
    reportType: row.report_type,
    alertGroupId: row.alert_group_id,
    inserted: row.inserted === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listReportForms(filters = {}) {
  const where = [];
  const params = [];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (filters.from) add('rf.created_at >= $?::date', String(filters.from).slice(0, 10));
  if (filters.to) add("rf.created_at < ($?::date + INTERVAL '1 day')", String(filters.to).slice(0, 10));
  if (filters.driverId) add('rf.driver_id = $?', Number(filters.driverId));
  if (filters.reportType) add('rf.report_type = $?', String(filters.reportType));
  const q = text(filters.q);
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(rf.report_no ILIKE ${p} OR rf.driver_name ILIKE ${p} OR rf.vehicle_fleet_number ILIKE ${p} OR rf.vehicle_registration ILIKE ${p})`);
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 2000, 1), 5000);
  params.push(limit);
  const result = await query(
    `SELECT rf.id, rf.report_no, rf.report_type, rf.alert_id, rf.alert_group_id,
            rf.driver_id, rf.driver_name, rf.vehicle_fleet_number, rf.vehicle_registration,
            rf.cost_center_id, rf.status, rf.created_by, rf.created_at, rf.updated_at,
            (SELECT COUNT(*)::int FROM report_evidence re WHERE re.report_form_id = rf.id) AS evidence_count
       FROM report_forms rf
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY rf.created_at DESC, rf.id DESC
      LIMIT $${params.length}`,
    params
  );

  const ctx = await linkage.createContext().catch(() => null);
  const requested = Array.isArray(filters.costCenterIds) ? new Set(filters.costCenterIds.map(Number)) : null;
  const enriched = result.rows.map((row) => {
    let ccId = row.cost_center_id == null ? null : Number(row.cost_center_id);
    let ccName = null;
    if (ctx && (row.vehicle_fleet_number || row.vehicle_registration)) {
      const resolved = linkage.resolveRow({
        fleet_number: row.vehicle_fleet_number || null,
        device_name: row.vehicle_fleet_number || row.vehicle_registration || null,
      }, ctx);
      if (resolved.cc_id != null) {
        ccId = Number(resolved.cc_id);
        ccName = resolved.cc_name || null;
      } else if (ccId != null) {
        ccName = ctx.registry.ccById?.get(ccId)?.name || null;
      }
    }
    return { ...row, cc_id: ccId, cc_name: ccName };
  });

  if (requested && requested.size === 0) return [];
  return enriched.filter((row) => !requested || (row.cc_id != null && requested.has(Number(row.cc_id))));
}

async function getReportForm(id) {
  const result = await query(
    `SELECT rf.*, 
            (SELECT COUNT(*)::int FROM report_evidence re WHERE re.report_form_id = rf.id) AS evidence_count
       FROM report_forms rf
      WHERE rf.id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return null;
  const evidence = await query(
    `SELECT id, alert_id, file_url, file_type, channel, captured_at
       FROM report_evidence WHERE report_form_id = $1 ORDER BY id ASC`,
    [id]
  );
  return { ...row, evidence: evidence.rows };
}

module.exports = { saveReportForm, listReportForms, getReportForm };
