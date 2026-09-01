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

module.exports = { findVehicleCostCenterId, invalidateVehicleCostCenter };
