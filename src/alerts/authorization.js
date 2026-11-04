// Model A authorization.
//
// The Cost Centre Alert Set is the allowlist:
//   - vehicle has a cost centre -> only active overrides for that CC
//   - vehicle has no cost centre -> only definitions explicitly marked global
// Group configs are combos/rollups and never gate individual alerts.

const db = require('../db');

const TTL_MS = 60 * 1000;
const cache = new Map();
let loading = new Map();

function cacheKey(ccId) {
  return ccId == null || ccId === '' ? 'global' : String(Number(ccId));
}

function buildMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const entry = {
      id: row.id,
      name: row.name,
      signalCode: row.signal_code || null,
      severity: String(row.override_severity || row.severity || 'MEDIUM').toLowerCase(),
      isGlobal: row.is_global === true,
    };
    if (entry.signalCode) map.set(`code:${String(entry.signalCode).toLowerCase()}`, entry);
    if (entry.name) map.set(`name:${String(entry.name).trim().toLowerCase()}`, entry);
    map.set(`id:${entry.id}`, entry);
  }
  return map;
}

async function loadSet(ccId) {
  const key = cacheKey(ccId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.map;

  const pending = loading.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      let rows;
      if (key === 'global') {
        rows = (await db.query(
          `SELECT id, name, signal_code, severity, is_global
             FROM alert_definitions
            WHERE is_active = TRUE AND is_global = TRUE`
        )).rows;
      } else {
        rows = (await db.query(
          `SELECT d.id, d.name, d.signal_code, d.severity, d.is_global,
                  o.severity AS override_severity
             FROM alert_definitions d
             JOIN alert_definition_overrides o
               ON o.alert_definition_id = d.id
              AND o.cost_center_id = $1
              AND o.is_active IS DISTINCT FROM false
            WHERE d.is_active = TRUE`,
          [Number(ccId)]
        )).rows;
      }
      const map = buildMap(rows);
      cache.set(key, { map, ts: Date.now() });
      return map;
    } catch (err) {
      console.error('[AUTHZ] effective set load failed:', err.message);
      return cached ? cached.map : new Map();
    } finally {
      loading.delete(key);
    }
  })();

  loading.set(key, promise);
  return promise;
}

function findInSet(map, { definitionId, signalCode, name }) {
  if (!map || map.size === 0) return null;
  if (definitionId != null && map.has(`id:${definitionId}`)) return map.get(`id:${definitionId}`);
  if (signalCode && map.has(`code:${String(signalCode).toLowerCase()}`)) return map.get(`code:${String(signalCode).toLowerCase()}`);
  if (name && map.has(`name:${String(name).trim().toLowerCase()}`)) return map.get(`name:${String(name).trim().toLowerCase()}`);
  return null;
}

/**
 * Resolve the effective definition for a vehicle's cost centre.
 * Returns null when the alert type is not in the vehicle's set.
 */
async function resolveDefinitionForVehicle({ costCenterId, signalCode, name, definitionId }) {
  const map = await loadSet(costCenterId);
  return findInSet(map, { definitionId, signalCode, name });
}

/**
 * True when a definition is allowed for the vehicle. This is the single gate
 * every write path calls (and upsertAlertGroup uses as a backstop).
 */
async function canRaiseAlert({ costCenterId, definitionId, signalCode, name }) {
  const def = await resolveDefinitionForVehicle({ costCenterId, definitionId, signalCode, name });
  return !!def;
}

function invalidate() {
  cache.clear();
}

module.exports = {
  resolveDefinitionForVehicle,
  canRaiseAlert,
  invalidate,
};
