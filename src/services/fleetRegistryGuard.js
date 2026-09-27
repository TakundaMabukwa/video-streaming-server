const { query } = require('../db/pool');

// Alerts are only raised for vehicles we operate: rows in `fleet_vehicles`.
// Geotab / camera devices that were never onboarded into the fleet registry
// must not create alerts.

const CACHE_TTL_MS = 60 * 1000;
const LOOKUP_CACHE = new Map();
let registryCache = { tokens: null, expiresAt: 0 };

// "VT11 - PD124 - JGW947FS", "VT11/PD124", "VT11-PD124" → [VT11, PD124, ...]
function matchTokens(value) {
  const seen = new Set();
  const tokens = [];
  const push = (raw) => {
    const token = String(raw || '').trim().toUpperCase();
    if (token.length < 2 || seen.has(token)) return;
    if (!/^[A-Z0-9]+$/.test(token)) return; // codes and plates are alphanumeric
    seen.add(token);
    tokens.push(token);
  };
  for (const slashPart of String(value || '').split(/[/\s-]+/)) push(slashPart);
  return tokens;
}

function vehicleTokens({ deviceId, deviceName } = {}) {
  const tokens = [];
  const seen = new Set();
  // deviceId is included: the NCR path passes only fleet_number as both id and
  // name ("230"), and a device id can never collide with fleet_vehicles unless
  // it really is that vehicle's fleet_number.
  for (const token of [...matchTokens(deviceName), ...matchTokens(deviceId)]) {
    if (seen.has(token)) continue;
    if (/^\d{10,}$/.test(token)) continue; // camera / IMEI numbers
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

async function loadRegistryTokens() {
  if (registryCache.tokens && registryCache.expiresAt > Date.now()) return registryCache.tokens;
  const result = await query('SELECT fleet_number, registration_number FROM fleet_vehicles');
  const tokens = new Set();
  for (const row of result.rows) {
    for (const token of matchTokens(row.fleet_number)) tokens.add(token);
    for (const token of matchTokens(row.registration_number)) tokens.add(token);
  }
  registryCache = { tokens, expiresAt: Date.now() + CACHE_TTL_MS };
  return tokens;
}

// True when a token matches fleet_vehicles.fleet_number or registration_number.
// Fails open: a registry lookup error must never drop a real alert.
async function isRegisteredVehicle({ deviceId, deviceName } = {}) {
  const tokens = vehicleTokens({ deviceId, deviceName });
  if (tokens.length === 0) return false;

  const cacheKey = tokens.join('|');
  const cached = LOOKUP_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let registry;
  try {
    registry = await loadRegistryTokens();
  } catch (error) {
    console.error('[FLEET-GUARD] fleet_vehicles lookup failed, allowing alert:', error.message);
    return true;
  }
  if (registry.size === 0) {
    console.warn('[FLEET-GUARD] fleet_vehicles is empty — allowing alerts until the registry is populated');
    return true;
  }

  const value = tokens.some((token) => registry.has(token));
  LOOKUP_CACHE.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (!value) {
    console.log(`[FLEET-GUARD] blocked: "${String(deviceName || deviceId)}" is not in fleet_vehicles`);
  }
  return value;
}

module.exports = { isRegisteredVehicle };
