const db = require('./index');

let cachedMap = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedTelematicsMap = null;
let telematicsCacheTime = 0;

let cachedTelematicsNameMap = null;
let telematicsNameCacheTime = 0;

let cachedTelematicsNameSeverityMap = null;
let telematicsNameSevCacheTime = 0;

let cachedVideoNameMap = null;
let videoNameCacheTime = 0;

const ccCache = new Map();
const ccTelematicsCache = new Map();
const ccTelematicsNameCache = new Map();
const ccTelematicsNameSevCache = new Map();

const singleDefCache = new Map(); // `${signalCode}:${ccId|global}` -> { def, ts }

function cacheKeyFor(ids) {
  if (!ids || ids.length === 0) return 'global';
  return ids.slice().sort().join(',');
}

/**
 * Build signal_code → severity map from CC-scoped rows.
 * Keys are lowercased for case-insensitive lookup.
 * `name` is ALSO keyed so lookups keep working after video alerts are stored
 * under their alert_definitions name instead of the raw signal code.
 */
function buildMap(rows) {
  const map = {};
  for (const row of rows) {
    const severity = (row.override_severity || row.severity || 'MEDIUM').toLowerCase();
    if (row.signal_code) map[String(row.signal_code).toLowerCase()] = severity;
    if (row.name) map[String(row.name).toLowerCase()] = severity;
  }
  return map;
}

// STRICT COST-CENTER RULE (applies to every map builder below):
// - When costCenterIds is non-empty (vehicle belongs to cost center(s)), the map
//   contains ONLY alert definitions explicitly added to those cost centers
//   (INNER JOIN alert_definition_overrides, inactive overrides excluded).
//   There is NO fallback to global definitions.
// - When empty (vehicle matches no cost center), the map contains the active
//   global definitions. Global is ONLY for CC-less vehicles.

async function getVideoSeverityMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedMap && now - cacheTime < CACHE_TTL_MS) return cachedMap;

    try {
      const result = await db.query(
        `SELECT signal_code, name, severity FROM alert_definitions
         WHERE category = 'video' AND is_active = true`
      );
      cachedMap = buildMap(result.rows);
      cacheTime = now;
      return cachedMap;
    } catch (error) {
      console.error('[alert_definitions] Failed to load video severity map:', error.message);
      return cachedMap || {};
    }
  }

  const now = Date.now();
  const cached = ccCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.map;

  try {
    const result = await db.query(
      `SELECT d.signal_code,
              d.name,
              d.severity,
              o.severity AS override_severity
       FROM alert_definitions d
       INNER JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = 'video' AND d.is_active = true
         AND o.is_active IS DISTINCT FROM false`,
      [costCenterIds]
    );
    const map = buildMap(result.rows);
    ccCache.set(key, { map, ts: now });
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC video severity map:', error.message);
    return cached ? cached.map : {};
  }
}

async function getTelematicsSeverityMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedTelematicsMap && now - telematicsCacheTime < CACHE_TTL_MS) return cachedTelematicsMap;

    try {
      const result = await db.query(
        `SELECT signal_code, name, severity FROM alert_definitions
         WHERE category = 'telematics' AND is_active = true`
      );
      cachedTelematicsMap = buildMap(result.rows);
      telematicsCacheTime = now;
      return cachedTelematicsMap;
    } catch (error) {
      console.error('[alert_definitions] Failed to load telematics severity map:', error.message);
      return cachedTelematicsMap || {};
    }
  }

  const now = Date.now();
  const cached = ccTelematicsCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.map;

  try {
    const result = await db.query(
      `SELECT d.signal_code,
              d.name,
              d.severity,
              o.severity AS override_severity
       FROM alert_definitions d
       INNER JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = 'telematics' AND d.is_active = true
         AND o.is_active IS DISTINCT FROM false`,
      [costCenterIds]
    );
    const map = buildMap(result.rows);
    ccTelematicsCache.set(key, { map, ts: now });
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC telematics severity map:', error.message);
    return cached ? cached.map : {};
  }
}

/**
 * Build per-CC severity maps: { [ccId]: { [lowercase_signal_code]: severity } }.
 * STRICT: each cost center gets ONLY its explicitly-added definitions
 * (INNER JOIN overrides). CCs with no overrides get an EMPTY map — never global.
 * Key 0 holds the global map and is ONLY for CC-less vehicles.
 * @param {number[]} ccIds - cost center IDs
 * @param {string|string[]} categories - 'video', 'telematics', or array of both
 */
async function getPerCCSeverityMaps(ccIds, categories = ['video', 'telematics']) {
  const cats = Array.isArray(categories) ? categories : [categories];

  if (!ccIds || ccIds.length === 0) {
    const videoMap = await getVideoSeverityMap([]);
    const telematicsMap = await getTelematicsSeverityMap([]);
    const merged = { ...telematicsMap, ...videoMap };
    return { 0: merged };
  }

  const perCC = {};

  try {
    const result = await db.query(
      `SELECT d.signal_code, d.name, d.severity, o.severity AS override_severity, o.cost_center_id
       FROM alert_definitions d
       INNER JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = ANY($2::text[]) AND d.is_active = true
         AND o.is_active IS DISTINCT FROM false`,
      [ccIds, cats]
    );

    for (const row of result.rows) {
      if (!row.signal_code && !row.name) continue;
      const ccKey = row.cost_center_id || 0;
      const severity = (row.override_severity || row.severity || 'MEDIUM').toLowerCase();
      if (!perCC[ccKey]) perCC[ccKey] = {};
      if (row.signal_code) perCC[ccKey][String(row.signal_code).toLowerCase()] = severity;
      if (row.name) perCC[ccKey][String(row.name).toLowerCase()] = severity;
    }

    for (const ccId of ccIds) {
      if (!perCC[ccId]) perCC[ccId] = {};
    }

    // Key 0 = global merged map, ONLY for CC-less vehicles. Never used as a
    // fallback for vehicles that belong to a cost center.
    const videoMap = await getVideoSeverityMap([]);
    const telematicsMap = await getTelematicsSeverityMap([]);
    perCC[0] = { ...telematicsMap, ...videoMap };

    return perCC;
  } catch (error) {
    console.error('[alert_definitions] Failed to build per-CC severity maps:', error.message);
    const videoMap = await getVideoSeverityMap([]);
    const telematicsMap = await getTelematicsSeverityMap([]);
    return { 0: { ...telematicsMap, ...videoMap } };
  }
}

/**
 * Build a name-based map for telematics: { lowercase_name: { signal_code, severity } }.
 * This allows matching incoming Geotab event names (e.g. "Driver Fatigue") directly
 * against alert_definitions without hardcoding signal code mappings.
 * Returns { nameMap, signalCodeMap } so raw rule-id event types (e.g.
 * "RuleHarshBrakingId" or an unresolvable hash) can still exact-match a definition.
 */
async function getTelematicsNameMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedTelematicsNameMap && now - telematicsNameCacheTime < CACHE_TTL_MS) return cachedTelematicsNameMap;

    try {
      const result = await db.query(
        `SELECT name, signal_code, severity FROM alert_definitions d
         WHERE category = 'telematics' AND is_active = true AND name IS NOT NULL AND name != ''
           AND signal_code IS DISTINCT FROM 'exceptionEvent'
           AND (
             -- genuinely global: no per-CC override rows at all
             NOT EXISTS (
               SELECT 1 FROM alert_definition_overrides o
               JOIN cost_centers cc ON cc.id = o.cost_center_id
               WHERE o.alert_definition_id = d.id AND cc.is_active IS DISTINCT FROM false
             )
             OR
             -- in-set for at least one active cost center
             EXISTS (
               SELECT 1 FROM alert_definition_overrides o
               JOIN cost_centers cc ON cc.id = o.cost_center_id
               WHERE o.alert_definition_id = d.id AND cc.is_active IS DISTINCT FROM false
                 AND o.is_active IS DISTINCT FROM false
             )
           )`
      );
      const map = {};
      const signalCodeMap = {};
      for (const row of result.rows) {
        const entry = { name: row.name, signalCode: row.signal_code, severity: (row.severity || 'MEDIUM').toLowerCase() };
        map[row.name.toLowerCase()] = entry;
        if (row.signal_code) signalCodeMap[row.signal_code.toLowerCase()] = entry;
      }
      cachedTelematicsNameMap = { nameMap: map, signalCodeMap };
      telematicsNameCacheTime = now;
      return cachedTelematicsNameMap;
    } catch (error) {
      console.error('[alert_definitions] Failed to load telematics name map:', error.message);
      return cachedTelematicsNameMap || { nameMap: {}, signalCodeMap: {} };
    }
  }

  const now = Date.now();
  const cached = ccTelematicsNameCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached;

  try {
const result = await db.query(
        `SELECT d.name, d.signal_code, d.severity, o.severity AS override_severity
         FROM alert_definitions d
         INNER JOIN alert_definition_overrides o
           ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
         WHERE d.category = 'telematics' AND d.is_active = true AND d.name IS NOT NULL AND d.name != ''
           AND d.signal_code IS DISTINCT FROM 'exceptionEvent'
           AND o.is_active IS DISTINCT FROM false`,
        [costCenterIds]
      );
      const map = {};
      const signalCodeMap = {};
      for (const row of result.rows) {
        const entry = {
          name: row.name,
          signalCode: row.signal_code,
          severity: (row.override_severity || row.severity || 'MEDIUM').toLowerCase(),
        };
        map[row.name.toLowerCase()] = entry;
        if (row.signal_code) signalCodeMap[row.signal_code.toLowerCase()] = entry;
      }
      const built = { nameMap: map, signalCodeMap, ts: now };
      ccTelematicsNameCache.set(key, built);
      return built;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC telematics name map:', error.message);
    return cached || { nameMap: {}, signalCodeMap: {} };
  }
}

/**
 * Build a name-based severity map for telematics: { lowercase_name: severity }.
 * Used by the controller to filter telematics alert_groups whose alarm_type is now the name.
 */
async function getTelematicsNameSeverityMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedTelematicsNameSeverityMap && now - telematicsNameSevCacheTime < CACHE_TTL_MS) return cachedTelematicsNameSeverityMap;

    try {
      const result = await db.query(
        `SELECT name, signal_code, severity FROM alert_definitions d
         WHERE category = 'telematics' AND is_active = true AND name IS NOT NULL AND name != ''
           AND signal_code IS DISTINCT FROM 'exceptionEvent'
           AND (
             -- genuinely global: no per-CC override rows at all
             NOT EXISTS (
               SELECT 1 FROM alert_definition_overrides o
               JOIN cost_centers cc ON cc.id = o.cost_center_id
               WHERE o.alert_definition_id = d.id AND cc.is_active IS DISTINCT FROM false
             )
             OR
             -- in-set for at least one active cost center
             EXISTS (
               SELECT 1 FROM alert_definition_overrides o
               JOIN cost_centers cc ON cc.id = o.cost_center_id
               WHERE o.alert_definition_id = d.id AND cc.is_active IS DISTINCT FROM false
                 AND o.is_active IS DISTINCT FROM false
             )
           )`
      );
      const map = {};
      for (const row of result.rows) {
        const sev = (row.severity || 'MEDIUM').toLowerCase();
        map[row.name.toLowerCase()] = sev;
        if (row.signal_code) map[row.signal_code.toLowerCase()] = sev;
      }
      cachedTelematicsNameSeverityMap = map;
      telematicsNameSevCacheTime = now;
      return cachedTelematicsNameSeverityMap;
    } catch (error) {
      console.error('[alert_definitions] Failed to load telematics name severity map:', error.message);
      return cachedTelematicsNameSeverityMap || {};
    }
  }

  const now = Date.now();
  const cached = ccTelematicsNameSevCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.map;

  try {
const result = await db.query(
        `SELECT d.name, d.signal_code, d.severity, o.severity AS override_severity
         FROM alert_definitions d
         INNER JOIN alert_definition_overrides o
           ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
         WHERE d.category = 'telematics' AND d.is_active = true AND d.name IS NOT NULL AND d.name != ''
           AND d.signal_code IS DISTINCT FROM 'exceptionEvent'
           AND o.is_active IS DISTINCT FROM false`,
        [costCenterIds]
      );
      const map = {};
      for (const row of result.rows) {
        const sev = (row.override_severity || row.severity || 'MEDIUM').toLowerCase();
        map[row.name.toLowerCase()] = sev;
        if (row.signal_code) map[row.signal_code.toLowerCase()] = sev;
      }
      ccTelematicsNameSevCache.set(key, { map, ts: now });
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC telematics name severity map:', error.message);
    return cached ? cached.map : {};
  }
}

/**
 * Global signal_code → alert_definitions.name map for the VIDEO category.
 * Video alerts arrive from the camera API keyed by signal code; ingest stores
 * the definition name instead so alert_groups/alerts line up with Alert Config.
 * Names are intrinsic to the definition (not per-CC), so one global map is enough.
 */
async function getVideoNameMap() {
  const now = Date.now();
  if (cachedVideoNameMap && now - videoNameCacheTime < CACHE_TTL_MS) return cachedVideoNameMap;

  try {
    const result = await db.query(
      `SELECT signal_code, name FROM alert_definitions
       WHERE category = 'video' AND is_active = true
         AND signal_code IS NOT NULL AND signal_code <> ''
         AND name IS NOT NULL AND name <> ''`
    );
    const map = {};
    for (const row of result.rows) {
      map[String(row.signal_code).toLowerCase()] = row.name;
    }
    cachedVideoNameMap = map;
    videoNameCacheTime = now;
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load video name map:', error.message);
    return cachedVideoNameMap || {};
  }
}

function invalidateCache() {
  cachedMap = null;
  cacheTime = 0;
  cachedVideoNameMap = null;
  videoNameCacheTime = 0;
  cachedTelematicsMap = null;
  telematicsCacheTime = 0;
  cachedTelematicsNameMap = null;
  telematicsNameCacheTime = 0;
  cachedTelematicsNameSeverityMap = null;
  telematicsNameSevCacheTime = 0;
  ccCache.clear();
  ccTelematicsCache.clear();
  ccTelematicsNameCache.clear();
  ccTelematicsNameSevCache.clear();
  singleDefCache.clear();
}

/**
 * Check whether a telematics alert definition (by exact signal_code) is active
 * for a given cost center, and return the definition when it is.
 * - signalCode must match an is_active=true definition. No match → null.
 * - costCenterId == null (CC-less vehicle) → definition's own is_active decides
 *   (global definitions are ONLY for vehicles with no cost center, mirroring
 *   the strict CC rule used by the severity-map builders above).
 * - costCenterId set → requires an active override row for that CC
 *   (o.is_active IS DISTINCT FROM false); no override → null.
 * @param {string} signalCode - exact alert_definitions.signal_code
 * @param {number|null} [costCenterId]
 * @returns {Promise<Object|null>} the matched { id, name, severity } definition or null
 */
async function isAlertActiveForCC(signalCode, costCenterId) {
  if (!signalCode) return null;
  const key = `${String(signalCode).toLowerCase()}:${costCenterId == null ? 'global' : costCenterId}`;
  const now = Date.now();
  const cached = singleDefCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.def;

  let def = null;
  try {
    const result = await db.query(
      `SELECT id, name, severity, signal_code FROM alert_definitions
       WHERE signal_code = $1 AND is_active = true
       LIMIT 1`,
      [signalCode]
    );
    const row = result.rows[0];
    if (!row) {
      singleDefCache.set(key, { def: null, ts: now });
      return null;
    }
    if (costCenterId == null) {
      def = { id: row.id, name: row.name, severity: row.severity || 'MEDIUM' };
    } else {
      const ov = await db.query(
        `SELECT severity FROM alert_definition_overrides
         WHERE alert_definition_id = $1 AND cost_center_id = $2
           AND is_active IS DISTINCT FROM false
         LIMIT 1`,
        [row.id, costCenterId]
      );
      if (ov.rows.length > 0) {
        def = { id: row.id, name: row.name, severity: String(ov.rows[0].severity || row.severity || 'MEDIUM').toLowerCase() };
      }
    }
  } catch (error) {
    console.error('[alert_definitions] isAlertActiveForCC error:', error.message);
    def = null;
  }

  singleDefCache.set(key, { def, ts: Date.now() });
  return def;
}

module.exports = { getVideoSeverityMap, getTelematicsSeverityMap, getTelematicsNameMap, getTelematicsNameSeverityMap, getPerCCSeverityMaps, getVideoNameMap, isAlertActiveForCC, invalidateCache };
