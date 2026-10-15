const { query } = require('../db');

// Cache vehicle -> cost_center_id (5-min TTL)
const lookupCache = new Map();
const LOOKUP_CACHE_TTL = 5 * 60 * 1000;

async function findVehicleCostCenterId(fleetNumber) {
  if (!fleetNumber) return null;

  const key = String(fleetNumber).toUpperCase();
  const cached = lookupCache.get(key);
  if (cached && Date.now() - cached.ts < LOOKUP_CACHE_TTL) return cached.ccId;

  let ccId = null;
  try {
    // Prefer driver_scoring.cost_center_id
    const scoring = await query(
      'SELECT cost_center_id FROM driver_scoring WHERE fleet_number = $1 LIMIT 1',
      [fleetNumber]
    );
    if (scoring.rows.length > 0) {
      ccId = scoring.rows[0].cost_center_id;
    }

    if (ccId == null) {
      const fv = await query(
        'SELECT cost_center_id FROM fleet_vehicles WHERE fleet_number = $1 OR registration_number = $1 LIMIT 1',
        [fleetNumber]
      );
      if (fv.rows.length > 0) {
        ccId = fv.rows[0].cost_center_id;
      }
    }
  } catch (err) {
    console.error('[costCenterLookup] Error looking up vehicle cost center:', err.message);
    ccId = null;
  }

  lookupCache.set(key, { ccId: ccId == null ? null : ccId, ts: Date.now() });
  return ccId == null ? null : ccId;
}

function invalidateVehicleCostCenter(fleetNumber) {
  if (fleetNumber) lookupCache.delete(String(fleetNumber).toUpperCase());
}

// DB-backed fleet check: is this token a real fleet (driver_scoring /
// fleet_vehicles, case-insensitive)? Catches single-letter (B27, M10) and
// numeric (230, 231) fleets the regexes reject. Cached 5 min.
const fleetTokenCache = new Map();
async function fleetTokenExists(token) {
  const key = String(token || '').trim().toUpperCase();
  if (!key || key.length > 24) return null;
  const cached = fleetTokenCache.get(key);
  if (cached && Date.now() - cached.ts < LOOKUP_CACHE_TTL) return cached.value;
  let value = null;
  try {
    const r = await query(
      `SELECT fleet_number FROM driver_scoring WHERE UPPER(fleet_number) = $1
       UNION SELECT fleet_number FROM fleet_vehicles WHERE UPPER(fleet_number) = $1
       LIMIT 1`,
      [key]
    );
    if (r.rows.length > 0) value = r.rows[0].fleet_number;
  } catch (_) { value = null; }
  fleetTokenCache.set(key, { value, ts: Date.now() });
  return value;
}

// Device-code -> fleet-number resolution cache (5-min TTL)
const fleetCache = new Map();
const FLEET_CACHE_TTL = 5 * 60 * 1000;

function looksLikeFleetCode(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (/^[A-Za-z]{2,}[\d-]*$/.test(s)) return true;
  if (/^[\d]{2,3}-[\d]{2,6}$/.test(s)) return true;
  return false;
}

// Extract the fleet prefix from registration/plate strings like "PB29 - JHD716FS"
// or "32 - EX55 - LCL660MP" (numeric prefix + fleet code + plate).
// Normalizes the same way as the frontend fleetKeyOf(): parenthetical suffixes
// ("FM13 (RAPID)" -> "FM13") and slashes ("VT11/PD124") are stripped first, so
// camera and Geotab names resolve to one fleet key.
function normalizeFleetString(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\//g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fleetFromRegistration(value) {
  const s = normalizeFleetString(value);
  if (!s) return null;
  const parts = s.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  // First, try to find a segment that looks like a fleet code (starts with 2+ letters).
  // For "32 - EX55 - LCL660MP", this finds "EX55".
  const fleetCode = parts.find(p => /^[A-Za-z]{2,}\d*$/.test(p));
  if (fleetCode && looksLikeFleetCode(fleetCode)) return fleetCode;

  // Fallback: check the first segment
  const first = parts[0];
  if (first && looksLikeFleetCode(first.split(/\s+/)[0])) return first.split(/\s+/)[0];
  if (looksLikeFleetCode(first)) return first;

  // DB-backed last resort: single-letter (B27, M10) and short numeric (230,
  // 231) fleets fail the regexes but live in the fleet tables. Exact match
  // only — shared depot prefixes never equal a fleet row, so no false merges.
  for (const p of parts) {
    const t = p.toUpperCase();
    if (!/^[A-Z]\d+$/.test(t) && !/^\d{2,3}$/.test(t)) continue;
    const hit = await fleetTokenExists(t);
    if (hit) return hit;
  }
  return null;
}

// Exact fleet resolution: registry values only, never name parsing. Returns
// the fleet code when the device/fleet is known EXACTLY (fleet tables,
// geotab_devices, vehicle_status, or the id itself being a fleet code), else
// null. This is what gets STORED on alert_groups.fleet_number and what every
// read path joins on — 100% match accuracy, zero guessing.
async function resolveFleetExact({ deviceId, fleetNumber } = {}) {
  const norm = (v) => String(v || '').trim();
  const fn = norm(fleetNumber);
  // Explicit fleet param wins if it is a real fleet (regex or fleet table).
  if (fn) {
    if (looksLikeFleetCode(fn)) return fn;
    const known = await fleetTokenExists(fn);
    if (known) return known;
  }
  const dev = norm(deviceId);
  if (!dev) return null;
  const key = `fleetexact:${dev}`;
  const cached = fleetCache.get(key);
  if (cached && Date.now() - cached.ts < FLEET_CACHE_TTL) return cached.value;
  let value = null;
  try {
    // Device id IS the fleet code (NCR rows, PD126-style devices).
    const selfHit = await fleetTokenExists(dev);
    if (selfHit) value = selfHit;
    if (!value) {
      const g = await query(
        `SELECT fleet_number FROM geotab_devices
         WHERE id = $1 OR serial_number = $1 LIMIT 1`,
        [dev]
      );
      const gf = norm(g.rows[0]?.fleet_number);
      if (gf && (looksLikeFleetCode(gf) || await fleetTokenExists(gf))) value = gf;
    }
    if (!value) {
      const vs = await query(
        `SELECT fleet_number FROM vehicle_status WHERE device_id = $1 LIMIT 1`,
        [dev]
      );
      const vf = norm(vs.rows[0]?.fleet_number);
      if (vf && (looksLikeFleetCode(vf) || await fleetTokenExists(vf))) value = vf;
    }
  } catch (err) {
    console.error('[costCenterLookup] resolveFleetExact error:', err.message);
    value = null;
  }
  fleetCache.set(key, { value, ts: Date.now() });
  return value;
}
async function resolveFleetNumber({ deviceId, vehicleRegistration, fleetNumber } = {}) {
  if (fleetNumber && looksLikeFleetCode(fleetNumber)) return String(fleetNumber).trim();
  if (fleetNumber) {
    const known = await fleetTokenExists(fleetNumber);
    if (known) return known;
  }

  const regFleet = await fleetFromRegistration(vehicleRegistration);
  if (regFleet) return regFleet;

  const dev = String(deviceId || '').trim();
  if (!dev) return null;

  const key = `fleet:${dev}`;
  const cached = fleetCache.get(key);
  if (cached && Date.now() - cached.ts < FLEET_CACHE_TTL) return cached.value;

  let value = null;
  try {
    const g = await query(
      `SELECT fleet_number, license_plate, name FROM geotab_devices
       WHERE id = $1 OR serial_number = $1 OR fleet_number = $1 LIMIT 1`,
      [dev]
    );
    if (g.rows.length > 0) {
      // geotab_devices.fleet_number sometimes holds the device serial rather than a
      // fleet code - only accept values that actually look like a fleet number.
      value = g.rows[0].fleet_number && looksLikeFleetCode(g.rows[0].fleet_number)
        ? g.rows[0].fleet_number
        : (await fleetFromRegistration(g.rows[0].license_plate) || await fleetFromRegistration(g.rows[0].name));
    }

    if (!value) {
      const vs = await query(
        `SELECT fleet_number, plate FROM vehicle_status WHERE device_id = $1 LIMIT 1`,
        [dev]
      );
      if (vs.rows.length > 0) {
        value = vs.rows[0].fleet_number
          || await fleetFromRegistration(vs.rows[0].plate);
      }
    }

    if (!value) {
      const te = await query(
        `SELECT fleet_number, plate, license_plate FROM telematics_events
         WHERE device_id = $1 ORDER BY event_time DESC NULLS LAST LIMIT 1`,
        [dev]
      );
      if (te.rows.length > 0) {
        value = te.rows[0].fleet_number
          || await fleetFromRegistration(te.rows[0].plate)
          || await fleetFromRegistration(te.rows[0].license_plate);
      }
    }

    if (!value && looksLikeFleetCode(dev)) value = dev;
    if (!value) {
      // Fleet-as-device-id (B27, NCR rows) that fails the regexes.
      const known = await fleetTokenExists(dev);
      if (known) value = known;
    }
  } catch (err) {
    console.error('[costCenterLookup] resolveFleetNumber error:', err.message);
    value = null;
  }

  // Device codes like PD126 are often the fleet number itself — never lose that on lookup failure.
  if (!value && looksLikeFleetCode(dev)) value = dev;

  fleetCache.set(key, { value: value == null ? null : value, ts: Date.now() });
  return value == null ? null : value;
}

// Canonical fleet token from any name string. Mirrors the frontend
// fleetKeyOf() preference order: real 2+-letter codes, then single-letter +
// digits (B27), then short numerics (230) — a lone depot prefix never wins
// while a better token exists.
function fleetTokenFromName(value) {
  const cleaned = normalizeFleetString(value);
  if (!cleaned) return '';
  const tokens = cleaned.split(' - ').map((p) => p.trim().toUpperCase()).filter(Boolean);
  const byShape = (re) => tokens.find((t) => re.test(t) && t.length <= 24);
  return byShape(/^[A-Z]{2,}[\d-]*$/) || byShape(/^[A-Z]\d+$/) || byShape(/^\d{2,3}$/) || '';
}

module.exports = { findVehicleCostCenterId, invalidateVehicleCostCenter, resolveFleetNumber, resolveFleetExact, normalizeFleetString, fleetFromRegistration, looksLikeFleetCode, fleetTokenExists, fleetTokenFromName };
