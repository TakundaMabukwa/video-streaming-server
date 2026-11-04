// Cost-centre visibility for the live SSE stream.
//
// HTTP board endpoints currently let the dashboard apply its selected CC
// filter. The live stream must do the same filtering server-side so a user
// never receives another tenant's alerts/locations.

const db = require('../db');

const TTL_MS = 5 * 60 * 1000;
let fleetCC = null;
let loadedAt = 0;
let loading = null;

const norm = (v) => String(v == null ? '' : v)
  .replace(/\([^)]*\)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

function ccSet(ccIds) {
  return new Set((ccIds || []).map((v) => Number(v)).filter((n) => Number.isFinite(n)));
}

async function load() {
  const [fv, ds] = await Promise.all([
    db.query('SELECT fleet_number, cost_center_id FROM fleet_vehicles').catch(() => ({ rows: [] })),
    db.query('SELECT fleet_number, cost_center_id FROM driver_scoring').catch(() => ({ rows: [] })),
  ]);
  const map = new Map();
  // fleet_vehicles wins; driver_scoring fills holes.
  for (const row of ds.rows) {
    const key = norm(row.fleet_number);
    if (key && row.cost_center_id != null) map.set(key, Number(row.cost_center_id));
  }
  for (const row of fv.rows) {
    const key = norm(row.fleet_number);
    if (key && row.cost_center_id != null) map.set(key, Number(row.cost_center_id));
  }
  fleetCC = map;
  loadedAt = Date.now();
  return map;
}

async function ensureLoaded() {
  if (fleetCC && Date.now() - loadedAt < TTL_MS) return fleetCC;
  if (loading) return loading;
  loading = load().finally(() => { loading = null; });
  return loading;
}

// A user with no CC assignments behaves like the current API: no restriction.
// A user with assignments only receives fleets mapped to one of those CCs.
async function canSeeFleet(ccIds, fleetNumber) {
  const allowed = ccSet(ccIds);
  if (allowed.size === 0) return true;
  const key = norm(fleetNumber);
  if (!key) return false;
  const map = await ensureLoaded();
  const cc = map.get(key);
  return cc != null && allowed.has(Number(cc));
}

function invalidate() {
  fleetCC = null;
  loadedAt = 0;
}

module.exports = { canSeeFleet, invalidate };
