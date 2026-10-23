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

// Registrations arrive in different shapes ("LCZ948MP" vs "EX63 - LCZ948MP"),
// so compare the whole value AND the last token.
const regTokens = (v) => {
  const full = norm(v).replace(/[^a-z0-9]+/g, "");
  const parts = norm(v).split(/[\s\-/]+/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1].replace(/[^a-z0-9]+/g, "") : "";
  return { full, last };
};

const regMatches = (a, b) => {
  if (!a || !b) return false;
  const ta = regTokens(a);
  const tb = regTokens(b);
  if (!ta.full || !tb.full) return false;
  if (ta.full === tb.full) return true;
  return !!ta.last && ta.last === tb.last;
};

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
 * @param {{fleetNumber?: string, registration?: string, alertName?: string, signalCode?: string, deviceName?: string}} input
 */
function isSuppressedSync({ fleetNumber, registration, alertName, signalCode, deviceName } = {}) {
  if (cache.size === 0) return false;
  const fleet = norm(fleetNumber);
  const reg = norm(registration);
  const name = norm(alertName);
  const code = norm(signalCode);
  // Camera detections identify the vehicle in the NAME, not in a fleet/reg
  // field: "RH23 - GGD359X" on an opaque device id. Without these fallbacks an
  // override saved for RH23 never matched a camera alert for that vehicle.
  const nameCandidates = nameCandidatesFrom(deviceName);
  for (const entry of cache.values()) {
    // Vehicle match: EITHER declared key matching is enough ("fleet or reg is
    // ok"). Both keys are optional; a row with only one matches on that one.
    // OR semantics are required in practice: the plate a detector reports is
    // not always the registry plate (camera vehicles report a device id in
    // license_plate), so requiring both would stop the override matching.
    let fleetHit = !!entry.fleet && entry.fleet === fleet;
    let regHit = !!entry.reg && regMatches(entry.reg, reg);
    if (!fleetHit) {
      fleetHit = nameCandidates.fleets.some((t) => entry.fleet && entry.fleet === t);
    }
    if (!regHit) {
      regHit = nameCandidates.regs.some((t) => entry.reg && regMatches(entry.reg, t));
    }
    if (!fleetHit && !regHit) continue;
    // Alert match: signal code first (stable), then the display name.
    if (code && entry.codes.has(code)) return true;
    if (name && entry.types.has(name)) return true;
  }
  return false;
}

// Fleet and plate candidates from a device name such as "RH23 - GGD359X".
// Short alphanumeric tokens only; long pure-digit camera/IMEI ids are skipped.
function nameCandidatesFrom(deviceName) {
  const fleets = [];
  const regs = [];
  const seen = new Set();
  const parts = String(deviceName || '').split(/[\s/\-()|,]+/);
  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (!token || token.length < 2 || token.length > 12) continue;
    if (!/^[a-z0-9]+$/.test(token)) continue;
    if (/^\d{6,}$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    fleets.push(token);
    regs.push(token);
  }
  return { fleets, regs };
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
