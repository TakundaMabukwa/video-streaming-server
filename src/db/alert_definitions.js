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

const ccCache = new Map();
const ccTelematicsCache = new Map();
const ccTelematicsNameCache = new Map();
const ccTelematicsNameSevCache = new Map();

function cacheKeyFor(ids) {
  if (!ids || ids.length === 0) return 'global';
  return ids.slice().sort().join(',');
}

/**
 * Build signal_code → severity map from base definitions + CC overrides.
 * CC override severity wins over base severity.
 */
function buildMap(rows) {
  const map = {};
  for (const row of rows) {
    if (row.signal_code) {
      map[row.signal_code] = (row.override_severity || row.severity || 'MEDIUM').toLowerCase();
    }
  }
  return map;
}

async function getVideoSeverityMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedMap && now - cacheTime < CACHE_TTL_MS) return cachedMap;

    try {
      const result = await db.query(
        `SELECT signal_code, severity FROM alert_definitions
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
              d.severity,
              o.severity AS override_severity
       FROM alert_definitions d
       LEFT JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = 'video' AND d.is_active = true`,
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
        `SELECT signal_code, severity FROM alert_definitions
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
              d.severity,
              o.severity AS override_severity
       FROM alert_definitions d
       LEFT JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = 'telematics' AND d.is_active = true`,
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
 * Build per-CC severity maps: { [ccId]: { [signal_code]: severity } }.
 * Each cost center gets its own override-aware map.
 * Falls back to global (base) severity when no override exists.
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
      `SELECT d.signal_code, d.severity, o.severity AS override_severity, o.cost_center_id
       FROM alert_definitions d
       LEFT JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = ANY($2::text[]) AND d.is_active = true`,
      [ccIds, cats]
    );

    for (const row of result.rows) {
      if (!row.signal_code) continue;
      const ccKey = row.cost_center_id || 0;
      if (!perCC[ccKey]) perCC[ccKey] = {};
      perCC[ccKey][row.signal_code] = (row.override_severity || row.severity || 'MEDIUM').toLowerCase();
    }

    const videoMap = await getVideoSeverityMap([]);
    const telematicsMap = await getTelematicsSeverityMap([]);
    const globalMap = { ...telematicsMap, ...videoMap };

    for (const ccId of ccIds) {
      if (!perCC[ccId]) perCC[ccId] = { ...globalMap };
    }

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
 */
async function getTelematicsNameMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedTelematicsNameMap && now - telematicsNameCacheTime < CACHE_TTL_MS) return cachedTelematicsNameMap;

    try {
      const result = await db.query(
        `SELECT name, signal_code, severity FROM alert_definitions
         WHERE category = 'telematics' AND is_active = true AND name IS NOT NULL AND name != ''`
      );
      const map = {};
      for (const row of result.rows) {
        map[row.name.toLowerCase()] = { signalCode: row.signal_code, severity: (row.severity || 'MEDIUM').toLowerCase() };
      }
      cachedTelematicsNameMap = map;
      telematicsNameCacheTime = now;
      return cachedTelematicsNameMap;
    } catch (error) {
      console.error('[alert_definitions] Failed to load telematics name map:', error.message);
      return cachedTelematicsNameMap || {};
    }
  }

  const now = Date.now();
  const cached = ccTelematicsNameCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.map;

  try {
    const result = await db.query(
      `SELECT d.name, d.signal_code, d.severity, o.severity AS override_severity
       FROM alert_definitions d
       LEFT JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = 'telematics' AND d.is_active = true AND d.name IS NOT NULL AND d.name != ''`,
      [costCenterIds]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.name.toLowerCase()] = {
        signalCode: row.signal_code,
        severity: (row.override_severity || row.severity || 'MEDIUM').toLowerCase(),
      };
    }
    ccTelematicsNameCache.set(key, { map, ts: now });
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC telematics name map:', error.message);
    return cached ? cached.map : {};
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
        `SELECT name, severity FROM alert_definitions
         WHERE category = 'telematics' AND is_active = true AND name IS NOT NULL AND name != ''`
      );
      const map = {};
      for (const row of result.rows) {
        map[row.name.toLowerCase()] = (row.severity || 'MEDIUM').toLowerCase();
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
      `SELECT d.name, d.severity, o.severity AS override_severity
       FROM alert_definitions d
       LEFT JOIN alert_definition_overrides o
         ON o.alert_definition_id = d.id AND o.cost_center_id = ANY($1::int[])
       WHERE d.category = 'telematics' AND d.is_active = true AND d.name IS NOT NULL AND d.name != ''`,
      [costCenterIds]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.name.toLowerCase()] = (row.override_severity || row.severity || 'MEDIUM').toLowerCase();
    }
    ccTelematicsNameSevCache.set(key, { map, ts: now });
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC telematics name severity map:', error.message);
    return cached ? cached.map : {};
  }
}

function invalidateCache() {
  cachedMap = null;
  cacheTime = 0;
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
}

module.exports = { getVideoSeverityMap, getTelematicsSeverityMap, getTelematicsNameMap, getTelematicsNameSeverityMap, getPerCCSeverityMaps, invalidateCache };
