const { query } = require('../db/pool');

// Alerts are only raised for vehicles we operate: rows in `fleet_vehicles`.
// Geotab / camera devices that were never onboarded into the fleet registry
// must not create alerts.

const CACHE_TTL_MS = 60 * 1000;
const LOOKUP_CACHE = new Map();

function matchTokens(value) {
  const seen = new Set();
  const tokens = [];
  const push = (raw) => {
    const token = String(raw || '').trim().toUpperCase();
    if (token.length < 2 || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const slashPart of String(value || '').split(/\s*\/\s*/)) {
    for (const dashPart of slashPart.split(/\s+-\s+/)) {
      for (const piece of dashPart.split(/\s+/)) push(piece);
    }
  }
  return tokens;
}

function vehicleTokens({ deviceId, deviceName } = {}) {
  const id = String(deviceId || '').trim().toUpperCase();
  const tokens = [];
  const seen = new Set();
  for (const token of [...matchTokens(deviceName), ...matchTokens(deviceId)]) {
    if (seen.has(token)) continue;
    if (token === id) continue; // a bare device id is not a fleet code
    if (/^\d{10,}$/.test(token)) continue; // camera / IMEI numbers
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

// Returns true when at least one token matches fleet_vehicles.fleet_number or
// fleet_vehicles.registration_number. Fails open: a registry lookup error must
// never drop a real alert.
async function isRegisteredVehicle({ deviceId, deviceName } = {}) {
  const tokens = vehicleTokens({ deviceId, deviceName });
  if (tokens.length === 0) return false;

  const cacheKey = tokens.join('|');
  const cached = LOOKUP_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value;
  try {
    const result = await query(
      `SELECT 1 FROM fleet_vehicles
        WHERE upper(trim(fleet_number)) = ANY($1::text[])
           OR upper(trim(registration_number)) = ANY($1::text[])
        LIMIT 1`,
      [tokens]
    );
    value = result.rows.length > 0;
    if (!value) {
      const empty = await query('SELECT 1 FROM fleet_vehicles LIMIT 1').catch(() => null);
      if (empty && empty.rows.length === 0) {
        console.warn('[FLEET-GUARD] fleet_vehicles is empty — allowing alerts until the registry is populated');
        return true;
      }
    }
  } catch (error) {
    console.error('[FLEET-GUARD] fleet_vehicles lookup failed, allowing alert:', error.message);
    return true;
  }

  LOOKUP_CACHE.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (!value) {
    console.log(`[FLEET-GUARD] blocked: "${String(deviceName || deviceId)}" is not in fleet_vehicles`);
  }
  return value;
}

module.exports = { isRegisteredVehicle };
