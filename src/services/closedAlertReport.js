// Closed-alert report snapshot.
//
// The report is deliberately scoped to a small SAST calendar range (the UI
// defaults to the last two calendar days) and returns aggregates plus one page
// of rows. It never ships the full range to the browser.
const reportStats = require('../db/reportStats');
const linkage = require('./reportLinkage');
const { query } = require('../db/pool');

const SNAPSHOT_TTL_MS = 20 * 1000;
const snapshotCache = new Map();
const snapshotInFlight = new Map();

function sastDate(offsetDays = 0) {
  const now = new Date();
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  sast.setUTCDate(sast.getUTCDate() + offsetDays);
  return sast.toISOString().slice(0, 10);
}

function defaultRange() {
  return { from: sastDate(-1), to: sastDate(0) };
}

function normalizeRange(from, to) {
  const fallback = defaultRange();
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : fallback.from;
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : fallback.to;
  return fromDate <= toDate ? { from: fromDate, to: toDate } : { from: toDate, to: fromDate };
}

function parseIdList(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return value.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
  }
  return String(value)
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
}

function parseBool(value) {
  return value === true || value === '1' || value === 'true';
}

function rowKey(row) {
  return String(row.vehicle_fleet || row.fleet_number || row.device_name || row.group_key || '').trim().toUpperCase();
}

function buildCostCentreStats(rows, costCenters) {
  const byId = new Map((costCenters || []).map((cc) => [Number(cc.id), cc]));
  const buckets = new Map();
  const vehiclesByCc = new Map();

  for (const row of rows) {
    if (row.cc_id == null) continue;
    const ccId = Number(row.cc_id);
    if (!buckets.has(ccId)) {
      const cc = byId.get(ccId);
      buckets.set(ccId, {
        cc_id: ccId,
        cc_name: cc?.name || row.cc_name || `CC ${ccId}`,
        closed_alerts: 0,
        alert_events: 0,
        ncrs: 0,
        vehicles: 0,
      });
    }
    const bucket = buckets.get(ccId);
    bucket.closed_alerts += 1;
    bucket.alert_events += Number(row.alert_count || 0);
    bucket.ncrs += Number(row.ncr_count || 0);
    if (!vehiclesByCc.has(ccId)) vehiclesByCc.set(ccId, new Set());
    const key = rowKey(row);
    if (key) vehiclesByCc.get(ccId).add(key);
  }

  for (const [ccId, bucket] of buckets) {
    bucket.vehicles = vehiclesByCc.get(ccId)?.size || 0;
  }

  return [...buckets.values()].sort(
    (a, b) => (b.closed_alerts - a.closed_alerts) || (a.cc_name || '').localeCompare(b.cc_name || '')
  );
}

// NCR counts per cost centre — queried directly from ncr_forms JOIN incidents.
// Uses incident_date (not nf.created_at) so it matches the alert date range
// and the drill-down. Independent of alert_groups so cleared alerts don't hide NCRs.
async function getNcrCountsByCostCentre({ from, to, costCenterIds } = {}) {
  const params = [];
  const conditions = [];
  if (from && to) {
    params.push(from, to);
    conditions.push(`i.incident_date >= $${params.length - 1}::date AND i.incident_date <= $${params.length}::date`);
  } else if (from) {
    params.push(from);
    conditions.push(`i.incident_date >= $${params.length}::date`);
  } else if (to) {
    params.push(to);
    conditions.push(`i.incident_date <= $${params.length}::date`);
  }
  const ccList = String(costCenterIds || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (ccList.length > 0) {
    params.push(ccList);
    conditions.push(`i.cost_center_id = ANY($${params.length}::int[])`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  console.log('[NCR-COUNTS] from=%s to=%s cc=%j params=%j where=%s', from, to, costCenterIds, params, where);
  const result = await query(
    `SELECT i.cost_center_id, COALESCE(cc.name, 'Unknown') AS name, COUNT(nf.id)::int AS ncrs
       FROM ncr_forms nf
       JOIN incidents i ON i.id = nf.incident_id
       LEFT JOIN cost_centers cc ON cc.id = i.cost_center_id
       ${where}
      GROUP BY i.cost_center_id, cc.name
      ORDER BY ncrs DESC`,
    params
  );
  return result.rows;
}

function buildCharts(stats, ncrCounts = []) {
  const sorted = [...stats].sort((a, b) => b.closed_alerts - a.closed_alerts);
  const topPie = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const pie = topPie.map((s) => ({
    cc_id: s.cc_id,
    name: s.cc_name,
    value: s.closed_alerts,
    events: s.alert_events,
  }));
  if (rest.length > 0) {
    pie.push({
      cc_id: null,
      name: 'Other',
      value: rest.reduce((sum, s) => sum + s.closed_alerts, 0),
      events: rest.reduce((sum, s) => sum + s.alert_events, 0),
    });
  }

  const bar = sorted.slice(0, 10).map((s) => ({
    cc_id: s.cc_id,
    name: s.cc_name,
    alerts: s.closed_alerts,
    events: s.alert_events,
    ncrs: s.ncrs,
  }));

  // NCR charts: direct query from ncr_forms JOIN incidents. All CCs, no cap.
  const ncrPie = ncrCounts.map((s) => ({
    cc_id: s.cost_center_id,
    name: s.name,
    value: Number(s.ncrs || 0),
    events: 0,
  }));
  const ncrBar = ncrCounts.map((s) => ({
    cc_id: s.cost_center_id,
    name: s.name,
    alerts: Number(s.ncrs || 0),
    events: 0,
    ncrs: Number(s.ncrs || 0),
  }));

  return { pie, bar, ncrPie, ncrBar };
}

async function buildDataset({ from, to }) {
  const range = normalizeRange(from, to);
  const key = `${range.from}|${range.to}`;
  const now = Date.now();
  const cached = snapshotCache.get(key);
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.data;
  if (snapshotInFlight.has(key)) return snapshotInFlight.get(key);

  const task = (async () => {
    const [context, rows] = await Promise.all([
      linkage.createContext(),
      reportStats.getClosedGroupsInRange(range),
    ]);

    const linked = (rows || []).map((row) => {
      const resolved = linkage.resolveRow(
        {
          ...row,
          cost_center_id: row.incident_cc_id == null ? row.cost_center_id : row.incident_cc_id,
        },
        context
      );
      return {
        group_id: Number(row.id),
        group_key: row.group_key,
        device_id: row.device_id,
        device_name: row.device_name,
        fleet_number: row.fleet_number,
        alarm_type: row.alarm_type,
        severity: row.severity,
        alert_count: Number(row.occurrence_count ?? row.count ?? 0),
        source_type: row.source_type,
        last_alert_ts: row.last_alert_ts,
        closed_at: row.closed_sast,
        closed_date: row.closed_date,
        ncr_count: Number(row.ncr_count || 0),
        ncr_nos: row.ncr_nos || null,
        ncr_incident_id: row.ncr_incident_id || null,
        ...resolved,
      };
    });

    const costCenters = (context.registry.costCenters || [])
      .filter((cc) => cc.is_active !== false)
      .map((cc) => ({
        id: Number(cc.id),
        name: cc.name,
        code: cc.code || null,
        is_active: cc.is_active !== false,
        vehicles: context.registry.vehicleCountByCc?.get(Number(cc.id)) || 0,
      }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const data = { range, rows: linked, costCenters };
    snapshotCache.set(key, { at: Date.now(), data });
    if (snapshotCache.size > 6) {
      const oldest = [...snapshotCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) snapshotCache.delete(oldest[0]);
    }
    return data;
  })();

  snapshotInFlight.set(key, task);
  try {
    return await task;
  } finally {
    snapshotInFlight.delete(key);
  }
}

function filterRows(rows, filters) {
  const costCenterIds = filters.costCenterIds;
  const selected = costCenterIds == null ? null : new Set(costCenterIds);
  const term = String(filters.q || '').trim().toLowerCase();
  const alertType = String(filters.alertType || '').trim().toLowerCase();
  const severity = String(filters.severity || '').trim().toLowerCase();
  const onlyWithNcr = parseBool(filters.onlyWithNcr);

  return rows.filter((row) => {
    if (selected && (row.cc_id == null || !selected.has(Number(row.cc_id)))) return false;
    if (onlyWithNcr && !(Number(row.ncr_count) > 0)) return false;
    if (alertType && String(row.alarm_type || '').toLowerCase() !== alertType) return false;
    if (severity && String(row.severity || '').toLowerCase() !== severity) return false;
    if (term) {
      const haystack = [
        row.vehicle_fleet,
        row.fleet_number,
        row.vehicle_registration,
        row.device_name,
        row.alarm_type,
        row.driver_name,
        row.cc_name,
      ].map((v) => String(v || '').toLowerCase()).join(' ');
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

async function getReportData(params) {
  const dataset = await buildDataset(params);
  const rows = filterRows(dataset.rows, params);
  const typeRows = filterRows(dataset.rows, { ...params, alertType: null });
  const alertTypes = [...new Set(typeRows.map((row) => row.alarm_type).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  return { ...dataset, rows, alertTypes };
}

function summarize(rows) {
  const vehicles = new Set();
  let alertEvents = 0;
  let ncrs = 0;
  const costCentres = new Set();
  for (const row of rows) {
    alertEvents += Number(row.alert_count || 0);
    ncrs += Number(row.ncr_count || 0);
    if (row.cc_id != null) costCentres.add(Number(row.cc_id));
    const key = rowKey(row);
    if (key) vehicles.add(key);
  }
  return {
    closed_alerts: rows.length,
    alert_events: alertEvents,
    ncrs,
    vehicles: vehicles.size,
    cost_centres: costCentres.size,
  };
}

async function getSnapshot(params = {}) {
  const { range, rows, costCenters, alertTypes } = await getReportData(params);
  const stats = buildCostCentreStats(rows, costCenters);
  const ncrCounts = await getNcrCountsByCostCentre({
    from: range.from,
    to: range.to,
    costCenterIds: params.costCenterIds,
  });

  // Merge direct NCR counts into cost_centre_stats so cards and charts agree.
  // The old stats[].ncrs came from closed-alert groups (broken by deletions).
  const ncrMap = new Map(ncrCounts.map((r) => [Number(r.cost_center_id), Number(r.ncrs || 0)]));
  for (const bucket of stats) {
    bucket.ncrs = ncrMap.get(bucket.cc_id) ?? 0;
    ncrMap.delete(bucket.cc_id);
  }
  // Add CCs that have NCRs but no closed alerts (e.g. "Unknown" with 34).
  for (const [ccId, count] of ncrMap) {
    const cc = (costCenters || []).find((c) => Number(c.id) === ccId);
    stats.push({
      cc_id: ccId,
      cc_name: cc?.name || `CC ${ccId}`,
      closed_alerts: 0,
      alert_events: 0,
      ncrs: count,
      vehicles: 0,
    });
  }
  stats.sort((a, b) => (b.ncrs - a.ncrs) || (b.closed_alerts - a.closed_alerts));

  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
  const page = Math.max(1, Number(params.page) || 1);
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const mappingIssues = rows
    .filter((row) => row.mapping_error)
    .slice(0, 20)
    .map((row) => ({
      group_id: row.group_id,
      fleet: row.fleet_number || null,
      device: row.device_name || null,
      reason: row.mapping_error,
    }));

  return {
    success: true,
    generated_at: new Date().toISOString(),
    range,
    summary: summarize(rows),
    cost_centre_stats: stats,
    charts: buildCharts(stats, ncrCounts),
    alert_types: alertTypes,
    cost_centers: costCenters,
    closed_alerts: rows.slice(start, start + pageSize),
    total,
    page,
    page_size: pageSize,
    mapping_issues: mappingIssues,
  };
}

async function getExportRows(params = {}) {
  const { range, rows } = await getReportData(params);
  return { range, rows };
}

function invalidate() {
  snapshotCache.clear();
}

module.exports = {
  getSnapshot,
  getExportRows,
  invalidate,
  normalizeRange,
  defaultRange,
};
