const db = require('../db');
const syncService = require('../services/syncService');
const { sendSuccess, sendError } = require('../helpers/response');
const { uploadDocument } = require('../helpers/storage');
const { transformDbAlert, resolveBaseSeverity, escalateSeverity } = require('../helpers/transform');
const { getTelematicsNameSeverityMap, getPerCCSeverityMaps } = require('../db/alert_definitions');
const { findVehicleCostCenterId, resolveFleetNumber } = require('../services/costCenterLookup');
const { applyNcrDeduction } = require('../services/driverScoringService');

let wsBroadcast = null;
function setWsBroadcast(fn) { wsBroadcast = fn; }

/**
 * STRICT COST-CENTER ALERT RULE.
 * Builds the per-device filter + severity lookup for a batch of alert groups:
 * - Device belongs to cost center(s) → ONLY that CC's explicitly-added alert
 *   definitions apply. No global fallback, ever.
 * - Device matches no cost center → active GLOBAL definitions apply.
 * - `NCR:` rows always pass (system-generated from already-gated alerts).
 */
async function buildStrictAlertFilter(deviceCC) {
  const ccIds = [...new Set([...deviceCC.values()])];
  const [perCCMaps, globalTelNameMap, ...perCCNameMaps] = await Promise.all([
    getPerCCSeverityMaps(ccIds),
    getTelematicsNameSeverityMap([]).catch(() => ({})),
    ...ccIds.map((cc) => getTelematicsNameSeverityMap([cc]).catch(() => ({}))),
  ]);
  const telNameMapByCC = {};
  ccIds.forEach((cc, i) => { telNameMapByCC[cc] = perCCNameMaps[i] || {}; });

  const passes = (g) => {
    if (String(g.alarm_type || '').startsWith('NCR:')) return true;
    const ccId = deviceCC.get(g.device_id);
    const alarmKey = (g.alarm_type || '').toLowerCase();
    if (g.source_type === 'telematics') {
      const nameMap = ccId ? (telNameMapByCC[ccId] || {}) : globalTelNameMap;
      return !!nameMap[alarmKey];
    }
    const sigMap = ccId ? (perCCMaps[ccId] || {}) : (perCCMaps[0] || {});
    return !!sigMap[alarmKey];
  };

  const severityFor = (g) => {
    const ccId = deviceCC.get(g.device_id);
    if (g.source_type === 'telematics') {
      return ccId ? (telNameMapByCC[ccId] || {}) : globalTelNameMap;
    }
    return ccId ? (perCCMaps[ccId] || {}) : (perCCMaps[0] || {});
  };

  return { passes, severityFor };
}

async function batchResolveDeviceCC(alertGroups) {
  const deviceIds = [...new Set(alertGroups.map(g => g.device_id).filter(Boolean))];
  if (deviceIds.length === 0) return { fleetMap: new Map(), deviceCC: new Map() };

  const fleetMap = new Map();
  const results = await Promise.allSettled(
    deviceIds.map(async (did) => {
      const fleet = await resolveFleetNumber({
        deviceId: did,
        vehicleRegistration: alertGroups.find(g => g.device_id === did)?.device_name,
      }).catch(() => null);
      if (fleet) fleetMap.set(did, fleet);
      return { deviceId: did, fleet };
    })
  );

  const uniqueFleets = [...new Set([...fleetMap.values()])];
  const deviceCC = new Map();

  const ccResults = await Promise.allSettled(
    uniqueFleets.map(async (fn) => {
      const ccId = await findVehicleCostCenterId(fn).catch(() => null);
      return { fleet: fn, ccId };
    })
  );

  for (const r of ccResults) {
    if (r.status === 'fulfilled' && r.value.ccId) {
      for (const [did, fleet] of fleetMap) {
        if (fleet === r.value.fleet) deviceCC.set(did, r.value.ccId);
      }
    }
  }

  const resolved = [...deviceCC.values()].filter(Boolean).length;
  if (resolved > 0) {
    console.log(`[batchResolve] ${resolved}/${deviceIds.length} devices resolved to CCs`);
  } else if (deviceIds.length > 0) {
    console.log(`[batchResolve] WARNING: 0/${deviceIds.length} devices resolved to CCs`);
    const sample = results.slice(0, 3).map(r => r.status === 'fulfilled' ? r.value : r.reason?.message);
    console.log(`[batchResolve] Sample:`, JSON.stringify(sample));
  }

  return { fleetMap, deviceCC };
}

async function getAlertsList(req, res) {
  try {
    const { pageSize = 50, pageIndex = 1, deviceIds, alarmType, startTime, endTime } = req.query;
    const result = await db.getAlertsPaginated({
      pageSize: parseInt(pageSize),
      pageIndex: parseInt(pageIndex),
      deviceIds,
      alarmType,
      startTime,
      endTime,
    });
    sendSuccess(res, result, 'Alerts retrieved from local DB');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getAlertDetail(req, res) {
  try {
    const { alertId } = req.params;
    if (!alertId) return sendError(res, 'Alert ID required', 400);
    // alert_media is never consulted — look up the raw row directly.
    const byPk = await db.query('SELECT * FROM alerts WHERE id = $1', [alertId]);
    let alert = byPk.rows.length > 0 ? byPk.rows[0] : null;
    if (!alert) alert = await db.getAlertGroupByAlertId(alertId);
    if (!alert) return sendError(res, 'Alert not found', 404);
    sendSuccess(res, alert, 'Alert detail retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function triggerSync(req, res) {
  try {
    syncService.runSync();
    sendSuccess(res, { message: 'Sync triggered' }, 'Sync started');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getSyncStatus(req, res) {
  try {
    const status = syncService.getStatus();
    const stats = await db.getStats();
    const groupStats = await db.getAlertGroupStats();
    sendSuccess(res, { ...status, stats: { ...stats, ...groupStats } }, 'Sync status retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getDevices(req, res) {
  try {
    const result = await db.query(
      `SELECT device_id, device_name, SUM(count) as alert_count,
       MAX(last_alert_ts) as last_alert_ts
       FROM alert_groups
       GROUP BY device_id, device_name
       ORDER BY last_alert_ts DESC NULLS LAST
       LIMIT 1000`
    );
    sendSuccess(res, { records: result.rows, total: result.rows.length }, 'Devices from local DB');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getAlertTypes(req, res) {
  try {
    const result = await db.query(
      `SELECT alarm_type, SUM(count) as alert_count
       FROM alert_groups
       GROUP BY alarm_type
       ORDER BY alert_count DESC
       LIMIT 200`
    );
    sendSuccess(res, result.rows, 'Alert types from local DB');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// `?limit=` handling for endpoints that now support fetching *everything*.
// - absent / `0` / `all`  -> null (no LIMIT)
// - a positive integer     -> that value
// - anything else          -> the endpoint's own default
function parseLimit(raw, fallback) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (s === '0' || s.toLowerCase() === 'all') return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function groupsToAlerts(groups, { passes, severityFor }, { includeCount = true } = {}) {
  return groups.filter((g) => passes(g)).map((g) => {
    const t = transformDbAlert(g, severityFor(g));
    if (includeCount) t.count = g.count || 1;
    return t;
  });
}

// Vehicle-level scope: if ANY open group of a vehicle passes the strict
// filter, ALL of that vehicle's open groups are included (same devices and
// same fleets). A visible vehicle never shows a partial alert set — this is
// what keeps board cards identical to the (unfiltered) timeline and resolve
// views. fleetMap comes from batchResolveDeviceCC; stored fleet_number is
// authoritative, resolved fleet is the fallback.
function groupsToAlertsVehicleScoped(groups, filterCtx, batch, { includeCount = true } = {}) {
  const { passes, severityFor } = filterCtx;
  const fleetMap = (batch && batch.fleetMap) || new Map();
  const fleetOf = (g) => {
    const stored = String(g.fleet_number || '').trim().toUpperCase();
    if (stored) return stored;
    const resolved = fleetMap.get(g.device_id);
    if (resolved) return String(resolved).trim().toUpperCase();
    return '';
  };
  const passingDevices = new Set();
  const passingFleets = new Set();
  for (const g of groups) {
    if (!passes(g)) continue;
    if (g.device_id) passingDevices.add(String(g.device_id));
    const f = fleetOf(g);
    if (f) passingFleets.add(f);
  }
  return groups
    .filter((g) => {
      if (passes(g)) return true;
      if (g.device_id && passingDevices.has(String(g.device_id))) return true;
      const f = fleetOf(g);
      return !!f && passingFleets.has(f);
    })
    .map((g) => {
      const t = transformDbAlert(g, severityFor(g));
      if (includeCount) t.count = g.count || 1;
      return t;
    });
}

async function getActiveAlerts(req, res) {
  try {
    const forceAll = req.query.includeAll === '1' || req.query.includeAll === 'true';
    const compact = req.query.compact === '1' || req.query.compact === 'true';
    const sinceRaw = req.query.since ? String(req.query.since).trim() : '';
    const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;

    // Delta path: only groups changed since the cursor + tombstones for
    // resolved ones. The board loads full once, then polls this.
    if (since) {
      const asOf = new Date().toISOString();
      const [changedGroups, removed] = await Promise.all([
        db.getActiveAlertChanges({ since }),
        db.getResolvedSince({ since }),
      ]);
      if (changedGroups.length > 5000) {
        // Window too wide (client was away too long) — tell it to full-reload.
        return res.json({ success: true, truncated: true, asOf, source: 'eps-db' });
      }
      const batch = forceAll ? { deviceCC: new Map(), fleetMap: new Map() } : await batchResolveDeviceCC(changedGroups);
      const filter = await buildStrictAlertFilter(batch.deviceCC);
      const alwaysPass = { ...filter, passes: () => true };
      const changed = forceAll
        ? groupsToAlerts(changedGroups, alwaysPass)
        : groupsToAlertsVehicleScoped(changedGroups, filter, batch);
      const removedIds = removed.map((r) => String(r.id));
      if (compact) {
        const packed = db.packAlerts(changed);
        return res.json({ success: true, columns: packed.columns, changed: packed.rows, removed: removedIds, asOf, source: 'eps-db' });
      }
      return res.json({ success: true, changed, removed: removedIds, asOf, source: 'eps-db' });
    }

    // Cursor-paginated hydration: ?cursorTs=ISO&cursorId=N&limit=10000.
    // Lets the dashboard hydrate 65k rows in background chunks instead of one
    // unbounded flush (30s socket timeout + gzip CPU spike). Keep-alive for compat:
    // no cursor => legacy unbounded behavior.
    const cursorTsRaw = req.query.cursorTs ? String(req.query.cursorTs).trim() : '';
    const cursorTs = cursorTsRaw && !Number.isNaN(Date.parse(cursorTsRaw)) ? new Date(cursorTsRaw).toISOString() : null;
    const cursorIdRaw = req.query.cursorId ? String(req.query.cursorId).trim() : '';
    const cursorId = cursorIdRaw !== '' && Number.isFinite(Number(cursorIdRaw)) ? Number(cursorIdRaw) : null;
    if (cursorTs || cursorId != null || req.query.limit != null) {
      const rawLimit = req.query.limit != null ? parseLimit(req.query.limit, 10000) : 10000;
      const pageLimit = rawLimit == null ? 10000 : rawLimit; // explicit all => one big page (compat)
      const page = await db.getActiveAlertGroupsPage({ limit: pageLimit, cursorTs, cursorId });
      const batch = forceAll ? { deviceCC: new Map(), fleetMap: new Map() } : await batchResolveDeviceCC(page.rows);
      const filter = await buildStrictAlertFilter(batch.deviceCC);
      const alwaysPass = { ...filter, passes: () => true };
      const alerts = forceAll
        ? groupsToAlerts(page.rows, alwaysPass)
        : groupsToAlertsVehicleScoped(page.rows, filter, batch);
      const pageInfo = { hasMore: page.hasMore, nextCursorTs: page.nextCursorTs, nextCursorId: page.nextCursorId };
      if (compact) {
        const packed = db.packAlerts(alerts);
        return res.json({ success: true, columns: packed.columns, rows: packed.rows, count: alerts.length, page: pageInfo, asOf: new Date().toISOString(), source: 'eps-db' });
      }
      return res.json({ success: true, alerts, count: alerts.length, page: pageInfo, asOf: new Date().toISOString(), source: 'eps-db' });
    }

    const limit = parseLimit(req.query.limit, 2000);
    const groups = await db.getActiveAlertGroupsWithMedia({ limit });

    // includeAll (resolve-all modal): keep every open group, bypassing the
    // strict cost-center filter so no alert is invisible and unresolvable.
    // Otherwise vehicle-level scope: any passing group pulls its whole
    // vehicle (devices + fleets) into view.
    const batch = forceAll ? { deviceCC: new Map(), fleetMap: new Map() } : await batchResolveDeviceCC(groups);
    const filter = await buildStrictAlertFilter(batch.deviceCC);
    const alwaysPass = { ...filter, passes: () => true };

    const alerts = forceAll
      ? groupsToAlerts(groups, alwaysPass)
      : groupsToAlertsVehicleScoped(groups, filter, batch);

    if (compact) {
      const packed = db.packAlerts(alerts);
      return res.json({ success: true, columns: packed.columns, rows: packed.rows, count: alerts.length, total: alerts.length, asOf: new Date().toISOString(), source: 'eps-db' });
    }
    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// Fast first paint: latest open group per vehicle. Small payload (one row per
// device) so the board renders instantly; the full 65k set hydrates after.
async function getActivePerVehicleAlerts(req, res) {
  try {
    const forceAll = req.query.includeAll === '1' || req.query.includeAll === 'true';
    const compact = req.query.compact === '1' || req.query.compact === 'true';
    const groups = await db.getActivePerVehicleGroups();
    const { deviceCC } = forceAll ? { deviceCC: new Map() } : await batchResolveDeviceCC(groups);
    const filter = await buildStrictAlertFilter(deviceCC);
    const alwaysPass = { ...filter, passes: () => true };
    const alerts = groupsToAlerts(groups, forceAll ? alwaysPass : filter);
    if (compact) {
      const packed = db.packAlerts(alerts);
      return res.json({ success: true, columns: packed.columns, rows: packed.rows, count: alerts.length, total: alerts.length, asOf: new Date().toISOString(), source: 'eps-db', view: 'per-vehicle' });
    }
    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, asOf: new Date().toISOString(), source: 'eps-db', view: 'per-vehicle' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// Alert Stats page: closed genuine alerts aggregated by cost center with top
// vehicles/drivers nested. Closed data barely moves, so cache 60s per param
// combo instead of re-aggregating on every card expand.
const closedSummaryCache = new Map();
const CLOSED_SUMMARY_TTL_MS = 60 * 1000;
async function getClosedSummaryByCC(req, res) {
  try {
    const rawDays = req.query.days != null ? Number(req.query.days) : 30;
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 365) : 30;
    const st = req.query.source_type ? String(req.query.source_type).trim().toLowerCase() : null;
    const sourceType = st === 'video' || st === 'telematics' ? st : null;
    const key = `${days}|${sourceType || 'all'}`;
    const hit = closedSummaryCache.get(key);
    if (hit && Date.now() - hit.at < CLOSED_SUMMARY_TTL_MS) {
      return res.json({ ...hit.body, cached: true });
    }
    const { perCC, tops } = await db.getClosedSummaryByCC({ days, sourceType });
    const byCC = new Map();
    for (const r of perCC) {
      byCC.set(r.cc_id, {
        id: r.cc_id,
        name: r.cc_name || 'Unassigned',
        groups: Number(r.groups) || 0,
        alerts: Number(r.alerts) || 0,
        vehicles: Number(r.vehicles) || 0,
        bySeverity: {
          critical: Number(r.critical) || 0,
          high: Number(r.high) || 0,
          medium: Number(r.medium) || 0,
          low: Number(r.low) || 0,
        },
        lastSeen: r.last_seen || null,
        topVehicles: [],
        topDrivers: [],
      });
    }
    const ensureBucket = (ccId) => {
      if (!byCC.has(ccId)) {
        byCC.set(ccId, {
          id: ccId, name: 'Unassigned', groups: 0, alerts: 0, vehicles: 0,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
          lastSeen: null, topVehicles: [], topDrivers: [],
        });
      }
      return byCC.get(ccId);
    };
    for (const t of tops) {
      const bucket = ensureBucket(t.cc_id);
      const entry = {
        fleet: t.fleet || 'Unknown',
        registration: t.registration || null,
        driver: t.driver || 'Unknown',
        alerts: Number(t.alerts) || 0,
        groups: Number(t.groups) || 0,
        lastSeen: t.last_seen || null,
      };
      if (t.kind === 'vehicle') bucket.topVehicles.push(entry);
      else bucket.topDrivers.push(entry);
    }
    const costCenters = [...byCC.values()].sort((a, b) => b.alerts - a.alerts);
    const totals = costCenters.reduce(
      (acc, c) => ({ alerts: acc.alerts + c.alerts, groups: acc.groups + c.groups, vehicles: acc.vehicles + c.vehicles }),
      { alerts: 0, groups: 0, vehicles: 0 }
    );
    const body = {
      success: true, days, sourceType: sourceType || 'all',
      totals, costCenters,
      asOf: new Date().toISOString(), source: 'eps-db',
      note: 'Closed genuine alerts only (resolved, not false). Drivers are point-in-time.',
    };
    closedSummaryCache.set(key, { at: Date.now(), body });
    if (closedSummaryCache.size > 20) {
      const oldest = [...closedSummaryCache.keys()][0];
      closedSummaryCache.delete(oldest);
    }
    res.json({ ...body, cached: false });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getResolvedAlerts(req, res) {
  try {
    // Closed history stays capped by default (12k+ rows); callers must ask
    // explicitly for more or for everything (`?limit=0` / `?limit=all`).
    // Date window: ?from=ISO&to=ISO (Closed lane defaults to last 7 days).
    const limit = parseLimit(req.query.limit, 2000);
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const groups = await db.getResolvedAlertGroupsWithMedia({ limit, from, to });

    const { deviceCC } = await batchResolveDeviceCC(groups);
    const filter = await buildStrictAlertFilter(deviceCC);

    const alerts = groupsToAlerts(groups, filter);

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db', from, to });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// Fast header counts for the open board — severity buckets + total, no rows.
//
// Mirrors the board exactly: one card per device (latest group wins, lane
// lifted to the device's highest open severity), same CC filter, same
// escalation math as transformDbAlert. Header numbers therefore match the
// pre-existing client-computed cards (per-device), NOT the raw group total.
const LEVEL_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const LEVEL_BY_RANK = ['low', 'low', 'medium', 'high', 'critical'];
async function getActiveAlertCounts(req, res) {
  try {
    const rows = await db.getActiveAlertCountRows();
    const { deviceCC } = await batchResolveDeviceCC(rows);
    const { passes, severityFor } = await buildStrictAlertFilter(deviceCC);
    const maxRankByDevice = new Map();
    for (const g of rows) {
      if (!g.device_id || !passes(g)) continue;
      // Mirror transformDbAlert: active follow-up within 15 min forces low.
      let level;
      if (g.follow_up && g.follow_up_at && (Date.now() - new Date(g.follow_up_at).getTime()) < 15 * 60 * 1000) {
        level = 'low';
      } else {
        const base = resolveBaseSeverity(g.alarm_type, severityFor(g));
        level = String(escalateSeverity(base, g.count) || 'medium').toLowerCase();
      }
      const rank = LEVEL_RANK[level] ?? 1;
      if (rank > (maxRankByDevice.get(g.device_id) ?? 0)) maxRankByDevice.set(g.device_id, rank);
    }
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const rank of maxRankByDevice.values()) {
      const level = LEVEL_BY_RANK[rank] || 'low';
      bySeverity[level] += 1;
    }
    res.json({ success: true, bySeverity, total: maxRankByDevice.size, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getActiveAlertsAll(req, res) {
  try {
    const limit = parseLimit(req.query.limit, 2000);
    const groups = await db.getActiveAlertGroupsAll({ limit });

    const batch = await batchResolveDeviceCC(groups);
    const filter = await buildStrictAlertFilter(batch.deviceCC);

    const alerts = groupsToAlertsVehicleScoped(groups, filter, batch, { includeCount: false });

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// GET /alerts?status=new|active|resolved|closed&limit=&offset=
//
// This used to fall through to the catch-all in alertRoutes.js, which answers
// `{ alerts: [], count: 0 }` for every unknown path — so the alert bell and the
// closed-status tab were permanently empty.
async function listAlerts(req, res) {
  try {
    const status = String(req.query.status ?? '').trim();
    const limit = parseLimit(req.query.limit, 2000);
    const offset = Number.parseInt(String(req.query.offset ?? ''), 10) || 0;

    const groups = await db.listAlertGroups({ status, limit, offset });

    const { deviceCC } = await batchResolveDeviceCC(groups);
    const filter = await buildStrictAlertFilter(deviceCC);

    const alerts = groupsToAlerts(groups, filter);

    res.json({
      success: true,
      alerts,
      count: alerts.length,
      total: alerts.length,
      source: 'eps-db'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertById(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);

    // Prefer alert_groups PK. Accept legacy last_alert_id only as open-path bridge.
    let alert = null;
    const asGroupPk = Number(id);
    if (Number.isInteger(asGroupPk) && asGroupPk >= 1 && String(asGroupPk) === String(id).trim()) {
      alert = await db.getAlertGroupById(asGroupPk);
    }
    if (!alert) {
      alert = await db.getAlertGroupByAlertId(id);
    }
    if (!alert) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }
    // Media comes from frontend Next routes — never block open on alert_media.
    alert.media = [];

    const { deviceCC } = await batchResolveDeviceCC([alert]);
    const ccId = deviceCC.get(alert.device_id);
    const ccIds = ccId ? [ccId] : [];
    const perCCMaps = await getPerCCSeverityMaps(ccIds);
    const severityMap = (ccId && perCCMaps[ccId]) || perCCMaps[0] || {};

    const transformed = transformDbAlert(alert, severityMap);
    transformed.count = alert.count || 1;
    transformed.notes = alert.notes || null;
    transformed.documents = Array.isArray(alert.documents) ? alert.documents : [];

    // Fetch speed from telematics_events using fleet_number and alert timestamp
    // Look within 5 minute range of the video alert
    // Extract fleet_number from vehicle_registration (e.g., "EX69 - LDR067MP" -> "EX69")
    let fleetNum = transformed.fleet_number || alert.fleet_number;
    if (!fleetNum && transformed.vehicle_registration) {
      const parts = transformed.vehicle_registration.split(' - ');
      fleetNum = parts[0]?.trim();
    }
    const alertTime = transformed.timestamp || alert.alarm_ts;
    
    if (fleetNum && alertTime) {
      try {
        console.log(`[SPEED] Looking up speed for fleet: ${fleetNum}, time: ${alertTime}`);
        const speedResult = await db.query(
          `SELECT speed, distance, duration_seconds FROM telematics_events
           WHERE fleet_number = $1 AND speed IS NOT NULL 
           AND event_time >= $2::timestamptz - INTERVAL '5 minutes'
           AND event_time <= $2::timestamptz + INTERVAL '5 minutes'
           ORDER BY ABS(EXTRACT(EPOCH FROM (event_time - $2::timestamptz))) ASC
           LIMIT 1`,
          [fleetNum, alertTime]
        );
        console.log(`[SPEED] Result: ${speedResult.rows.length} rows`);
        if (speedResult.rows.length > 0) {
          transformed.speed = speedResult.rows[0].speed;
          transformed.distance = speedResult.rows[0].distance;
          transformed.duration_seconds = speedResult.rows[0].duration_seconds;
          transformed.metadata = { ...transformed.metadata, speed: speedResult.rows[0].speed };
          console.log(`[SPEED] Set speed: ${speedResult.rows[0].speed} for fleet ${fleetNum}`);
        }
      } catch (e) { console.log(`[SPEED] Error: ${e.message}`); }
    } else if (fleetNum) {
      // Fallback: get most recent speed for this fleet
      try {
        const speedResult = await db.query(
          `SELECT speed, distance, duration_seconds FROM telematics_events
           WHERE fleet_number = $1 AND speed IS NOT NULL
           ORDER BY event_time DESC LIMIT 1`,
          [fleetNum]
        );
        if (speedResult.rows.length > 0) {
          transformed.speed = speedResult.rows[0].speed;
          transformed.distance = speedResult.rows[0].distance;
          transformed.duration_seconds = speedResult.rows[0].duration_seconds;
          transformed.metadata = { ...transformed.metadata, speed: speedResult.rows[0].speed };
        }
      } catch (e) { /* non-critical */ }
    }

    const media = alert.media || [];
    transformed.screenshots = [];
    transformed.videos = [];

    res.json({ success: true, alert: { ...transformed, videos: [], videoCaptures: [] }, target: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function resolveMediaAlertId(id) {
  const asGroupPk = Number(id);
  if (Number.isInteger(asGroupPk) && asGroupPk >= 1 && String(asGroupPk) === String(String(id).trim())) {
    const group = await db.getAlertGroupById(asGroupPk);
    if (group) return { group, alertId: group.last_alert_id };
  }
  const byLastAlert = await db.getAlertGroupByAlertId(id);
  if (byLastAlert) return { group: byLastAlert, alertId: byLastAlert.last_alert_id };
  return { group: null, alertId: id };
}

async function getAlertScreenshots(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);

    const { group, alertId } = await resolveMediaAlertId(id);

    // Always live-fetch from skycamx — alert_media is never consulted.
    const rawAlert = await loadRawAlertForSkycam(id, group, alertId);
    if (!rawAlert) {
      return res.json({ success: true, screenshots: [], count: 0, source: 'skycamx' });
    }

    const media = await syncService.fetchMediaOnDemand(rawAlert);
    const screenshots = media
      .filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01')
      .map((m, i) => ({
        id: m.id || `shot-${i}`,
        url: m.file_url,
        storage_url: m.file_url,
        timestamp: m.created_at || m.alarm_time,
      }));

    res.json({ success: true, screenshots, count: screenshots.length, source: 'skycamx' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// Build the minimal alert record skycamx needs (alarm id + device + ts).
// Never touches alert_media — always resolves to a raw row/group then live-fetches.
async function loadRawAlertForSkycam(id, group, alertId) {
  if (alertId) {
    const byLast = await db.query('SELECT * FROM alerts WHERE id = $1', [alertId]);
    if (byLast.rows.length > 0) return byLast.rows[0];
  }
  const byPk = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
  if (byPk.rows.length > 0) return byPk.rows[0];
  if (group) {
    return {
      id: alertId || id,
      deviceId: group.device_id,
      deviceName: group.device_name,
      alarmType: group.alarm_type,
      alarmTs: group.last_alert_ts,
    };
  }
  return null;
}

async function getAlertMedia(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);

    const { group, alertId } = await resolveMediaAlertId(id);

    // Always live-fetch from skycamx — alert_media is never consulted.
    const rawAlert = await loadRawAlertForSkycam(id, group, alertId);
    if (!rawAlert && !group) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    const finalMedia = rawAlert ? await syncService.fetchMediaOnDemand(rawAlert) : [];
    const finalImages = finalMedia.filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01');
    const finalVideoFiles = finalMedia.filter((m) => m.file_type === '02');

    let severityMap = {};
    const severitySubject = group || rawAlert;
    try {
      const { deviceCC } = await batchResolveDeviceCC([severitySubject]);
      const ccId = deviceCC.get(severitySubject.device_id);
      const ccIds = ccId ? [ccId] : [];
      const perCCMaps = await getPerCCSeverityMaps(ccIds);
      severityMap = (ccId && perCCMaps[ccId]) || perCCMaps[0] || {};
    } catch (mapErr) {
      console.error(`[ALERT] severityMap resolution error for ${id}:`, mapErr.message);
    }

    const transformed = transformDbAlert(severitySubject, severityMap);
    if (group && transformed) transformed.count = group.count;

    const screenshots = finalImages.map((m, i) => ({
      id: m.id || `shot-${i}`,
      url: m.file_url ? `/api/video-server/playback/image-proxy?url=${encodeURIComponent(m.file_url)}` : null,
      storage_url: m.file_url,
      timestamp: m.created_at || m.alarm_time,
    }));

    const entries = finalVideoFiles.map((m) => {
      const flvProxyUrl = m.file_url
        ? `/api/video-server/playback/flv-proxy?url=${encodeURIComponent(m.file_url)}`
        : null;
      return {
        id: m.id,
        label: 'Alert Media',
        url: flvProxyUrl || m.file_url,
        flvProxyUrl,
        fileUrl: m.file_url,
        fileType: m.file_type || '02',
        isFlv: true,
        timestamp: m.created_at || m.alarm_time,
      };
    });

    const primaryUrl = entries[0]?.url || '';

    res.json({
      success: true,
      alert: transformed,
      screenshots,
      videos: entries,
      captures: entries,
      alertCaptures: entries,
      clipUrls: {
        pre: primaryUrl,
        post: primaryUrl,
        camera: primaryUrl,
        preRaw: primaryUrl,
        postRaw: primaryUrl,
      },
      source: 'skycamx',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// transformDbAlert and getAlertCoordinates moved to helpers/transform.js

async function resolveHistoryDeviceIds(deviceId, fleetNumber) {
  const ids = new Set();
  if (deviceId) ids.add(deviceId);

  // Exact: fleet params are verbatim values (case-insensitive); the device
  // fallback below resolves exactly through registries. Nothing is parsed.
  let fleet = String(fleetNumber || '').trim().toUpperCase() || null;
  if (!fleet && deviceId) {
    fleet = await resolveFleetNumber({ deviceId }).catch(() => null);
  }
  if (!fleet && deviceId) {
    const named = await db.query(
      `SELECT device_name FROM alert_groups WHERE device_id = $1 ORDER BY last_alert_ts DESC NULLS LAST LIMIT 1`,
      [deviceId]
    ).catch(() => ({ rows: [] }));
    const deviceName = named.rows[0]?.device_name || '';
    fleet = await resolveFleetNumber({ vehicleRegistration: deviceName, deviceId }).catch(() => null);
  }
  if (!fleet) return { deviceIds: [...ids], fleet: null };

  try {
    const g = await db.query(
      `SELECT id FROM geotab_devices WHERE upper(trim(fleet_number)) = upper($1)`,
      [fleet]
    );
    g.rows.forEach((r) => r.id && ids.add(r.id));
  } catch (_) { /* optional table */ }

  try {
    const vs = await db.query(
      `SELECT device_id FROM vehicle_status WHERE upper(trim(fleet_number)) = upper($1)`,
      [fleet]
    );
    vs.rows.forEach((r) => r.device_id && ids.add(r.device_id));
  } catch (_) { /* optional table */ }

  try {
    // Exact fleet-column match (authoritative). No name parsing, no ILIKE.
    let lastSeen = null;
    for (let page = 0; page < 40; page++) {
      const found = await db.query(
        `SELECT DISTINCT device_id FROM alert_groups
         WHERE upper(trim(coalesce(fleet_number, ''))) = upper($1)
           ${lastSeen ? `AND device_id > $2` : ''}
         ORDER BY device_id LIMIT 500`,
        lastSeen ? [fleet, lastSeen] : [fleet]
      );
      if (found.rows.length === 0) break;
      found.rows.forEach((r) => r.device_id && ids.add(String(r.device_id)));
      lastSeen = found.rows[found.rows.length - 1].device_id;
      if (found.rows.length < 500) break;
    }
  } catch (_) { /* ignore */ }

  return { deviceIds: [...ids], fleet };
}

async function getAlertHistory(req, res) {
  try {
    // Modal timeline defaults to the last 7 days / 100 rows ("load more"
    // asks explicitly); caps unchanged so callers can still widen.
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 2000);
    const deviceId = String(req.query.device_id || req.query.vehicleId || '').trim();
    const fleetNumber = String(req.query.fleet_number || req.query.fleetNumber || '').trim();
    const includeResolved = ['true', '1', 'yes'].includes(String(req.query.include_resolved || '').toLowerCase());

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const params = [cutoff];
    let where = 'alarm_ts >= $1';
    if (!includeResolved) {
      where += ' AND (resolved IS NOT TRUE) AND (false_alert IS NOT TRUE)';
    }

    // Same filters for the telematics branch, applied inside telematics_events
    // (bare columns — single-table scope) so both branches can use their time
    // indexes and stop early on LIMIT.
    const telNameExpr = `COALESCE(NULLIF(fleet_number, ''), device_id) || COALESCE(CASE WHEN NULLIF(license_plate, '') IS NOT NULL THEN ' - ' || license_plate END, '')`;
    let telWhere = 'event_time >= $1';

    const { deviceIds, fleet } = await resolveHistoryDeviceIds(deviceId, fleetNumber);
    if (deviceIds.length === 1) {
      params.push(deviceIds[0]);
      where += ` AND device_id = $${params.length}`;
      telWhere += ` AND device_id = $${params.length}`;
    } else if (deviceIds.length > 1) {
      params.push(deviceIds);
      where += ` AND device_id = ANY($${params.length}::text[])`;
      telWhere += ` AND device_id = ANY($${params.length}::text[])`;
    } else if (fleet) {
      // No concrete device ids — match vehicle by fleet code in device_name
      // (covers cross-source: video camera id vs Geotab short id).
      params.push(fleet);
      const n = params.length;
      where += ` AND (
        split_part(coalesce(device_name, ''), ' - ', 1) ILIKE $${n}
        OR split_part(coalesce(device_name, ''), ' - ', 2) ILIKE $${n}
        OR upper(coalesce(device_name, '')) LIKE upper('%' || $${n} || '%')
      )`;
      telWhere += ` AND (
        split_part(${telNameExpr}, ' - ', 1) ILIKE $${n}
        OR split_part(${telNameExpr}, ' - ', 2) ILIKE $${n}
        OR upper(${telNameExpr}) LIKE upper('%' || $${n} || '%')
      )`;
    }

    // History is two-source: video/Mettax rows live in `alerts`; telematics
    // rows are read from `telematics_events` (matched to a definition by exact
    // name, then exact signal_code — same order as matchAlertDefinition).
    // Events already stored in `alerts` (pre-cutover) are excluded so nothing
    // appears twice. Per-event state mirrors the old `alerts` rows (which
    // resolve never updated): resolved=false, status='new'.
    // Each branch takes its own top-`limit` (correct: union of top-N per
    // source = top-N overall) — keeps both branches on index scans.
    // `limit`/50000 are parseInt'd ints — safe to inline.
    const result = await db.query(
      `SELECT id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, source_type, status,
              resolved, false_alert, notes, lat, lon, alarm_text, created_at, updated_at
       FROM (
         (SELECT id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, source_type, status,
                 resolved, false_alert, notes, lat, lon, alarm_text, created_at, updated_at
          FROM alerts
          WHERE ${where}
          ORDER BY alarm_ts DESC
          LIMIT ${limit})

         UNION ALL

         (SELECT COALESCE('tel-' || m.device_id || '-' || (m.raw_data ->> 'id'), 'tel-' || m.device_id || '-e' || m.id) AS id,
                 m.device_id,
                 m.device_name,
                 m.alarm_type,
                 m.event_time AS alarm_ts,
                 NULL::timestamptz AS alarm_ts_end,
                 'telematics' AS source_type,
                 'new' AS status,
                 FALSE AS resolved,
                 FALSE AS false_alert,
                 NULL::text AS notes,
                 m.latitude AS lat,
                 m.longitude AS lon,
                 m.event_type || COALESCE(' in zone ' || NULLIF(m.zone_name, ''), '') AS alarm_text,
                 m.created_at,
                 NULL::timestamptz AS updated_at
          FROM (
            SELECT p.*, COALESCE(dn.name, dc.name) AS alarm_type
            FROM (
              SELECT e.*, ${telNameExpr} AS device_name
              FROM telematics_events e
              WHERE ${telWhere}
              ORDER BY e.event_time DESC
              LIMIT 50000
            ) p
            LEFT JOIN (
              SELECT lower(name) AS lname, min(name) AS name
              FROM alert_definitions
              WHERE category = 'telematics' AND is_active AND name IS NOT NULL AND name <> ''
                AND signal_code IS DISTINCT FROM 'exceptionEvent'
              GROUP BY 1
            ) dn ON dn.lname = lower(p.event_type)
            LEFT JOIN (
              SELECT lower(signal_code) AS lcode, min(name) AS name
              FROM alert_definitions
              WHERE category = 'telematics' AND is_active AND name IS NOT NULL AND name <> ''
                AND signal_code IS DISTINCT FROM 'exceptionEvent'
              GROUP BY 1
            ) dc ON dc.lcode = lower(p.event_code)
          ) m
          WHERE m.alarm_type IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM alerts a
              WHERE a.source_type = 'telematics'
                AND a.device_id = m.device_id
                AND a.alarm_ts = m.event_time
                AND a.alarm_type = m.alarm_type
            )
          ORDER BY m.event_time DESC
          LIMIT ${limit})
       ) h
       ORDER BY alarm_ts DESC
       LIMIT ${limit}`,
      params
    );

    // Strict filter parity with the active-alerts list: history rows whose
    // alarm_type is no longer in the device's cost-center set (or active
    // global for CC-less devices) are hidden.
    let rows = result.rows;
    try {
      const { deviceCC } = await batchResolveDeviceCC(rows);
      const { passes } = await buildStrictAlertFilter(deviceCC);
      rows = rows.filter((g) => passes(g));
    } catch (filterError) {
      console.error('[Alerts] History filter failed:', filterError.message);
    }

    res.json({
      success: true,
      alerts: rows,
      history: rows,
      data: rows,
      count: rows.length,
      days,
      device_id: deviceId || null,
      fleet_number: fleet || fleetNumber || null,
      device_ids: deviceIds,
      include_resolved: includeResolved,
    });
  } catch (error) {
    console.error('[Alerts] History error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}

async function acknowledgeAlert(req, res) {
  res.json({ success: true, alertId: req.params.id, action: 'acknowledge', message: 'EPS read-only: acknowledged locally' });
}

async function resolveAlert(req, res) {
  try {
    const { id } = req.params;
    const {
      userId,
      notes,
      closureType = 'resolved',
      documents: docData,
      action_taken,
      ncr_classification,
      close_reason,
      reported_by,
      incident: incidentData = {},
    } = req.body || {};

    const groupId = Number(id);
    if (!Number.isInteger(groupId) || groupId < 1 || String(id).trim() === '') {
      return res.status(400).json({ success: false, message: 'Alert id must be alert_groups.id (integer)' });
    }

    const isFalse = closureType === 'false_alert';
    const now = new Date().toISOString();

    const group = await db.getAlertGroupById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

    const resolved = await db.resolveAlertGroupById(groupId, {
      resolved: true,
      false_alert: isFalse,
      resolved_by: userId || null,
      resolved_at: now,
      notes: notes || null,
    });
    if (!resolved) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

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

      if (incident) {
        if (isFalse) {
          await db.updateIncidentFields(incident.id, { status: 'FALSE_ALERT', closure_type: closureType });
        } else {
          try {
            deduction = await applyNcrDeduction(fleetNumber, group.alarm_type);
          } catch (deductErr) {
            console.error('[ResolveAlert] NCR deduction error:', deductErr.message);
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

    res.json({
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
    });

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
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function escalateAlert(req, res) {
  res.json({ success: true, alertId: req.params.id, action: 'escalate', message: 'EPS read-only: escalated locally' });
}

async function markFalseAlert(req, res) {
  try {
    const { id } = req.params;
    const { userId, notes } = req.body || {};

    const groupId = Number(id);
    if (!Number.isInteger(groupId) || groupId < 1 || String(id).trim() === '') {
      return res.status(400).json({ success: false, message: 'Alert id must be alert_groups.id (integer)' });
    }

    const group = await db.getAlertGroupById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

    const now = new Date().toISOString();
    const updated = await db.resolveAlertGroupById(groupId, {
      resolved: true,
      false_alert: true,
      resolved_by: userId || null,
      resolved_at: now,
      notes: notes || null,
    });
    if (!updated) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

    if (wsBroadcast) {
      wsBroadcast('alert-status-changed', {
        alert: {
          id: String(groupId),
          alert_id: String(groupId),
          status: 'resolved',
          resolved: true,
          false_alert: true,
          resolved_by: userId || null,
          group_key: group.group_key,
          device_id: group.device_id || null,
          alert_type: group.alarm_type || null,
        },
      });
    }

    res.json({
      success: true,
      alertId: String(groupId),
      groupId,
      action: 'mark-false',
      resolved: true,
      false_alert: true,
      groups: 1,
      count: Number(group.count) || 1,
      message: `Alert group ${groupId} marked as false alarm`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function uploadDocumentToAlert(req, res) {
  try {
    const { id } = req.params;
    const { type, filled_by, link, url } = req.body || {};

    if (!type) {
      return res.status(400).json({ success: false, message: 'Document type is required' });
    }

    const groupId = Number(id);
    if (!Number.isInteger(groupId) || groupId < 1 || String(id).trim() === '') {
      return res.status(400).json({ success: false, message: 'Alert id must be alert_groups.id (integer)' });
    }

    const group = await db.getAlertGroupById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

    let publicUrl;
    if (req.files && req.files.file) {
      const file = req.files.file;
      const safeName = `${groupId}_${type}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      publicUrl = await uploadDocument(file.data, safeName, file.mimetype);
    } else {
      publicUrl = String(link || url || '').trim();
      if (!publicUrl) {
        return res.status(400).json({ success: false, message: 'Multipart file or a JSON body with "link" is required' });
      }
    }

    const timestamp = (req.body && req.body.timestamp) || new Date().toISOString();

    const document = {
      type,
      timestamp,
      filled_by: filled_by || 'unknown',
      link: publicUrl,
    };

    await db.appendAlertGroupDocument(groupId, document);

    res.json({
      success: true,
      alertId: String(groupId),
      groupId,
      action: 'document-uploaded',
      document,
      message: `Document uploaded to alert group ${groupId}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function followUpAlert(req, res) {
  try {
    const { id } = req.params;
    const { originalSeverity } = req.body || {};

    const groupId = Number(id);
    if (!Number.isInteger(groupId) || groupId < 1 || String(id).trim() === '') {
      return res.status(400).json({ success: false, message: 'Alert id must be alert_groups.id (integer)' });
    }

    const group = await db.getAlertGroupById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

    await db.resolveAlertGroupById(groupId, {
      follow_up: true,
      follow_up_at: new Date().toISOString(),
      original_severity: originalSeverity || group.original_severity || null,
    });

    res.json({
      success: true,
      alertId: String(groupId),
      groupId,
      follow_up: true,
      message: 'Follow-up set',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function clearFollowUp(req, res) {
  try {
    const { id } = req.params;

    const groupId = Number(id);
    if (!Number.isInteger(groupId) || groupId < 1 || String(id).trim() === '') {
      return res.status(400).json({ success: false, message: 'Alert id must be alert_groups.id (integer)' });
    }

    const group = await db.getAlertGroupById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: `Alert group ${groupId} not found` });
    }

    await db.resolveAlertGroupById(groupId, {
      follow_up: false,
      follow_up_at: null,
      original_severity: null,
    });

    res.json({
      success: true,
      alertId: String(groupId),
      groupId,
      follow_up: false,
      message: 'Follow-up cleared',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function resolveAlertsBulk(req, res) {
  try {
    const { alertIds, userId, notes, notesById, closureType = 'resolved' } = req.body || {};
    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return res.status(400).json({ success: false, message: 'alertIds array is required' });
    }

    const isFalse = closureType === 'false_alert';
    const now = new Date().toISOString();

    const uniqueIds = [...new Set(alertIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1))];
    if (uniqueIds.length === 0) {
      return res.status(400).json({ success: false, message: 'alertIds must be alert_groups.id integers' });
    }

    const n = uniqueIds.length;
    const pFalse = n + 1;
    const pBy = n + 2;
    const pAt = n + 3;
    const pNotes = n + 4;
    const pIds = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');

    const groupResult = await db.query(
      `UPDATE alert_groups
       SET resolved = TRUE,
           false_alert = $${pFalse}::boolean,
           resolved_by = $${pBy},
           resolved_at = $${pAt}::timestamptz,
           notes = COALESCE($${pNotes}, notes),
           updated_at = NOW()
       WHERE resolved = FALSE AND id IN (${pIds})
       RETURNING id, group_key, count, device_id, alarm_type`,
      [...uniqueIds, isFalse, userId || null, now, notes || null]
    );

    if (notesById && typeof notesById === 'object') {
      for (const [key, note] of Object.entries(notesById)) {
        const gid = Number(key);
        const noteText = String(note || '').trim();
        if (!Number.isInteger(gid) || gid < 1 || !noteText) continue;
        if (!uniqueIds.includes(gid)) continue;
        await db.query(
          `UPDATE alert_groups SET notes = $1, updated_at = NOW() WHERE id = $2`,
          [noteText, gid]
        );
      }
    }

    const resolvedCount = groupResult.rowCount || 0;
    const resolvedIds = groupResult.rows.map((r) => r.id);

    res.json({
      success: resolvedCount > 0,
      resolved: resolvedCount,
      groups: resolvedCount,
      ids: resolvedIds,
      total: alertIds.length,
      message: resolvedCount > 0
        ? `${resolvedCount} group(s) resolved`
        : 'No active groups matched those ids',
    });

    if (wsBroadcast) {
      for (const row of groupResult.rows) {
        wsBroadcast('alert-status-changed', {
          alert: {
            id: String(row.id),
            alert_id: String(row.id),
            status: 'resolved',
            resolved: true,
            false_alert: isFalse,
            resolved_by: userId || null,
            group_key: row.group_key,
            device_id: row.device_id,
            alert_type: row.alarm_type,
          },
        });
      }
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}


async function getResolvedAlertCount(req, res) {
  try {
    const count = await db.getResolvedAlertGroupCount();
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, count: 0, message: error.message });
  }
}

// Watching presence: which operators currently have an alert open. Heartbeat
// rows older than 90s are treated as gone (closed tab, crashed session).
const WATCH_STALE_MS = 90 * 1000;

async function sweepStaleWatchers() {
  try {
    await db.query(`DELETE FROM alert_watchers WHERE heartbeat_at < NOW() - INTERVAL '90 seconds'`);
  } catch (_) { /* never block onpresence cleanup */ }
}

function watcherIds(value) {
  if (Array.isArray(value)) return value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1);
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? [n] : [];
}

async function watchAlert(req, res) {
  try {
    const ids = watcherIds(req.params.id);
    const user = String(req.body?.user || '').trim().slice(0, 120) || 'unknown';
    if (ids.length === 0) return sendError(res, 'Alert ID required', 400);
    for (const id of ids) {
      await db.query(
        `INSERT INTO alert_watchers (alert_group_id, user_email, heartbeat_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (alert_group_id, user_email)
         DO UPDATE SET heartbeat_at = NOW()`,
        [id, user]
      );
    }
    // Presence is poll-only (heartbeat POST + watchers GET): no socket emits,
    // so every screen converges through the same HTTP path.
    res.json({ success: true, watching: ids.map(String) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function unwatchAlert(req, res) {
  try {
    const ids = watcherIds(req.params.id);
    const user = String(req.body?.user || req.query?.user || '').trim().slice(0, 120);
    if (ids.length === 0) return sendError(res, 'Alert ID required', 400);
    if (user) {
      await db.query(`DELETE FROM alert_watchers WHERE alert_group_id = ANY($1::int[]) AND user_email = $2`, [ids, user]);
    } else {
      await db.query(`DELETE FROM alert_watchers WHERE alert_group_id = ANY($1::int[])`, [ids]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertWatchers(req, res) {
  try {
    const ids = watcherIds(req.params.id);
    if (ids.length === 0) return sendError(res, 'Alert ID required', 400);
    await sweepStaleWatchers();
    const rows = await db.query(
      `SELECT alert_group_id, user_email, heartbeat_at FROM alert_watchers
       WHERE alert_group_id = ANY($1::int[]) AND heartbeat_at > NOW() - INTERVAL '90 seconds'
       ORDER BY heartbeat_at DESC`,
      [ids]
    );
    res.json({ success: true, watchers: rows.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAllWatchers(req, res) {
  try {
    await sweepStaleWatchers();
    const rows = await db.query(
      `SELECT alert_group_id, user_email, heartbeat_at FROM alert_watchers
       WHERE heartbeat_at > NOW() - INTERVAL '90 seconds'
       ORDER BY heartbeat_at DESC LIMIT 500`
    );
    const byAlert = {};
    for (const r of rows.rows) {
      const k = String(r.alert_group_id);
      (byAlert[k] = byAlert[k] || []).push(r.user_email);
    }
    res.json({ success: true, watching: byAlert, count: rows.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  getAlertsList,
  getAlertDetail,
  triggerSync,
  getSyncStatus,
  getDevices,
  getAlertTypes,
  getActiveAlerts,
  getActiveAlertsAll,
  getActivePerVehicleAlerts,
  getActiveAlertCounts,
  getClosedSummaryByCC,
  getResolvedAlerts,
  listAlerts,
  getResolvedAlertCount,
  getAlertById,
  getAlertScreenshots,
  getAlertMedia,
  getAlertHistory,
  acknowledgeAlert,
  resolveAlert,
  resolveAlertsBulk,
  watchAlert,
  unwatchAlert,
  getAlertWatchers,
  getAllWatchers,
  sweepStaleWatchers,
  escalateAlert,
  markFalseAlert,
  uploadDocumentToAlert,
  followUpAlert,
  clearFollowUp,
  setWsBroadcast,
  batchResolveDeviceCC,
  buildStrictAlertFilter,
};
