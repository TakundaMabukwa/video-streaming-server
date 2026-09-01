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

// Build the human vehicle fleet number for an alert. EPS/Geotab alerts carry raw
// device codes (e.g. '221085903184'); map them to the fleet number we display
// (e.g. 'EX41') using the local Geotab/telematics indexes.
async function resolveFleetNumber({ deviceId, vehicleRegistration, fleetNumber } = {}) {
  if (fleetNumber && looksLikeFleetCode(fleetNumber)) return String(fleetNumber).trim();

  const reg = String(vehicleRegistration || '').trim();
  const regParts = reg.split(' - ').map((p) => p.trim()).filter(Boolean);
  const regFirst = regParts[0];
  if (regFirst && looksLikeFleetCode(regFirst)) return regFirst;

  const dev = String(deviceId || '').trim();
  if (!dev) return null;

  const key = `fleet:${dev}`;
  const cached = fleetCache.get(key);
  if (cached && Date.now() - cached.ts < FLEET_CACHE_TTL) return cached.value;

  let value = null;
  try {
    const g = await query(
      'SELECT fleet_number FROM geotab_devices WHERE id = $1 OR serial_number = $1 LIMIT 1',
      [dev]
    );
    if (g.rows.length > 0 && g.rows[0].fleet_number) value = g.rows[0].fleet_number;

    if (!value) {
      const vs = await query('SELECT fleet_number FROM vehicle_status WHERE device_id = $1 LIMIT 1', [dev]);
      if (vs.rows.length > 0 && vs.rows[0].fleet_number) value = vs.rows[0].fleet_number;
    }

    if (!value) {
      const te = await query(
        `SELECT fleet_number FROM telematics_events
         WHERE device_id = $1 AND fleet_number IS NOT NULL
         ORDER BY event_time DESC NULLS LAST LIMIT 1`,
        [dev]
      );
      if (te.rows.length > 0) value = te.rows[0].fleet_number;
    }
  } catch (err) {
    console.error('[costCenterLookup] resolveFleetNumber error:', err.message);
    value = null;
  }

  fleetCache.set(key, { value: value == null ? null : value, ts: Date.now() });
  return value == null ? null : value;
}

module.exports = { findVehicleCostCenterId, invalidateVehicleCostCenter, resolveFleetNumber };
