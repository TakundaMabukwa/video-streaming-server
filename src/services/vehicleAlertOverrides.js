// Vehicle alert overrides: alerts that must never be raised for a given
// vehicle (e.g. a truck whose GPS is mis-calibrated and trips 85 km/h
// constantly).
//
// Matching keys: fleet_number and registration are INDEPENDENT. A row that
// carries only a fleet number matches on fleet; only a registration matches
// on registration; both present means both must match. An empty field is a
// wildcard.
//
// Performance: the table is tiny (a handful of rows), so the whole set is
// cached in memory as a Map and refreshed on a timer / on write. The
// detection hot path does an O(1) lookup — no query per alert.
const db = require('../db');

const REFRESH_MS = 60 * 1000;

// key -> { fleet, reg, types:Set(lowercased), codes:Set(lowercased) }
let cache = new Map();
let cacheLoadedAt = 0;
let refreshTimer = null;
let loading = false;

const norm = (v) => String(v || '').trim().toLowerCase();

function keyFor(fleetNumber, registration) {
  return `${norm(fleetNumber)}|${norm(registration)}`;
}

async function loadOverrides() {
  if (loading) return cache;
  loading = true;
  try {
    const { rows } = await db.query(
      `SELECT id, fleet_number, registration, alert_types, signal_codes, is_active
       FROM vehicle_alert_overrides
       WHERE is_active = TRUE`
    );
    const next = new Map();
    for (const r of rows) {
      next.set(keyFor(r.fleet_number, r.registration), {
        fleet: norm(r.fleet_number),
        reg: norm(r.registration),
        types: new Set((r.alert_types || []).map(norm).filter(Boolean)),
        codes: new Set((r.signal_codes || []).map(norm).filter(Boolean)),
      });
    }
    cache = next;
    cacheLoadedAt = Date.now();
  } catch (err) {
    // Never block detection on a cache failure — keep the last good set.
    console.error('[OVERRIDES] load failed:', err.message);
  } finally {
    loading = false;
  }
  return cache;
}

function ensureTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { loadOverrides().catch(() => {}); }, REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

async function ensureLoaded() {
  ensureTimer();
  if (cacheLoadedAt === 0 || Date.now() - cacheLoadedAt > REFRESH_MS) {
    await loadOverrides();
  }
  return cache;
}

/**
 * True when this vehicle must not raise this alert.
 * @param {{fleetNumber?: string, registration?: string, alertName?: string, signalCode?: string}} input
 */
function isSuppressedSync({ fleetNumber, registration, alertName, signalCode } = {}) {
  if (cache.size === 0) return false;
  const fleet = norm(fleetNumber);
  const reg = norm(registration);
  const name = norm(alertName);
  const code = norm(signalCode);
  for (const entry of cache.values()) {
    // Vehicle match: every key the row declares must match; empty = wildcard.
    if (entry.fleet && entry.fleet !== fleet) continue;
    if (entry.reg && entry.reg !== reg) continue;
    if (!entry.fleet && !entry.reg) continue;
    // Alert match: signal code first (stable), then the display name.
    if (code && entry.codes.has(code)) return true;
    if (name && entry.types.has(name)) return true;
  }
  return false;
}

/** Async variant for callers that can await (cold paths). */
async function isSuppressed(input) {
  await ensureLoaded();
  return isSuppressedSync(input);
}

function invalidate() {
  cacheLoadedAt = 0;
  return loadOverrides();
}

function start() {
  ensureTimer();
  loadOverrides().catch(() => {});
}

module.exports = { isSuppressed, isSuppressedSync, invalidate, loadOverrides, start };
