// Model A authorization.
//
// The Cost Centre Alert Set is the allowlist:
//   - vehicle has a cost centre -> only active overrides for that CC
//   - vehicle has no cost centre -> only definitions explicitly marked global
// Group configs are combos/rollups and never gate individual alerts.
//
// Two independent channels per (definition, cost centre):
//   individual_active — may an individual alert be raised for this type
//   member_active     — may the type stage as a combo group member
// Both default TRUE; the master switch is_active = FALSE kills both channels.
// 'group-only' (individual off, member on) is exactly the case an operator
// wants when a noisy member type should only feed a combination.

const db = require('../db');

const TTL_MS = 60 * 1000;
const cache = new Map();
let loading = new Map();

function cacheKey(ccId, mode) {
  const base = ccId == null || ccId === '' ? 'global' : String(Number(ccId));
  return `${base}:${mode || 'individual'}`;
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

async function loadSet(ccId, mode = 'individual') {
  const key = cacheKey(ccId, mode);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.map;

  const pending = loading.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      let rows;
      if (mode === 'any') {
        // Union of both channels — used to keep the raw stream flowing to the
        // combo gate when only one channel is off.
        if (ccId == null || ccId === '') {
          rows = (await db.query(
            `SELECT id, name, signal_code, severity, is_global
               FROM alert_definitions
              WHERE is_active = TRUE AND is_global = TRUE
                AND (COALESCE(individual_active, TRUE) OR COALESCE(member_active, TRUE))`
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
              WHERE d.is_active = TRUE
                AND (COALESCE(d.individual_active, TRUE) OR COALESCE(d.member_active, TRUE))
                AND (COALESCE(o.individual_active, TRUE) OR COALESCE(o.member_active, TRUE))`,
            [Number(ccId)]
          )).rows;
        }
      } else {
        const col = mode === 'member' ? 'member_active' : 'individual_active';
        if (ccId == null || ccId === '') {
          rows = (await db.query(
            `SELECT id, name, signal_code, severity, is_global
               FROM alert_definitions
              WHERE is_active = TRUE AND is_global = TRUE
                AND COALESCE(${col}, TRUE) = TRUE`
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
              WHERE d.is_active = TRUE
                AND d.${col} IS NOT DISTINCT FROM TRUE
                AND o.${col} IS NOT DISTINCT FROM TRUE`,
            [Number(ccId)]
          )).rows;
        }
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

async function resolveDefinitionForVehicle({ costCenterId, signalCode, name, definitionId }) {
  const map = await loadSet(costCenterId, 'individual');
  return findInSet(map, { definitionId, signalCode, name });
}

async function resolveComboMemberForVehicle({ costCenterId, signalCode, name, definitionId }) {
  const map = await loadSet(costCenterId, 'member');
  return findInSet(map, { definitionId, signalCode, name });
}

async function canRaiseAlert({ costCenterId, definitionId, signalCode, name }) {
  const def = await resolveDefinitionForVehicle({ costCenterId, definitionId, signalCode, name });
  return !!def;
}

async function canUseAsComboMember({ costCenterId, signalCode, name, definitionId }) {
  const def = await resolveComboMemberForVehicle({ costCenterId, signalCode, name, definitionId });
  return !!def;
}

async function canRaiseOrStage({ costCenterId, signalCode, name, definitionId }) {
  const map = await loadSet(costCenterId, 'any');
  return !!findInSet(map, { definitionId, signalCode, name });
}

function invalidate() {
  cache.clear();
  loading = new Map();
}

module.exports = {
  resolveDefinitionForVehicle,
  resolveComboMemberForVehicle,
  canRaiseAlert,
  canUseAsComboMember,
  canRaiseOrStage,
  invalidate,
};
