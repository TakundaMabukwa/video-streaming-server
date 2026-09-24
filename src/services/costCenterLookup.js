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
function fleetFromRegistration(value) {
  const s = String(value || '').trim();
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
  return null;
}

// Build the human vehicle fleet number for an alert. EPS/Geotab alerts carry raw
// device codes (e.g. '221085903184'); map them to the fleet number we display
// (e.g. 'EX41') using the local Geotab/telematics indexes.
async function resolveFleetNumber({ deviceId, vehicleRegistration, fleetNumber } = {}) {
  if (fleetNumber && looksLikeFleetCode(fleetNumber)) return String(fleetNumber).trim();

  const regFleet = fleetFromRegistration(vehicleRegistration);
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
        : (fleetFromRegistration(g.rows[0].license_plate) || fleetFromRegistration(g.rows[0].name));
    }

    if (!value) {
      const vs = await query(
        `SELECT fleet_number, plate FROM vehicle_status WHERE device_id = $1 LIMIT 1`,
        [dev]
      );
      if (vs.rows.length > 0) {
        value = vs.rows[0].fleet_number
          || fleetFromRegistration(vs.rows[0].plate);
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
          || fleetFromRegistration(te.rows[0].plate)
          || fleetFromRegistration(te.rows[0].license_plate);
      }
    }

    if (!value && looksLikeFleetCode(dev)) value = dev;
  } catch (err) {
    console.error('[costCenterLookup] resolveFleetNumber error:', err.message);
    value = null;
  }

  // Device codes like PD126 are often the fleet number itself — never lose that on lookup failure.
  if (!value && looksLikeFleetCode(dev)) value = dev;

  fleetCache.set(key, { value: value == null ? null : value, ts: Date.now() });
  return value == null ? null : value;
}

module.exports = { findVehicleCostCenterId, invalidateVehicleCostCenter, resolveFleetNumber };
