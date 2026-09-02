const db = require('./index');

let cachedMap = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedTelematicsMap = null;
let telematicsCacheTime = 0;

const ccCache = new Map();
const ccTelematicsCache = new Map();

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

function invalidateCache() {
  cachedMap = null;
  cacheTime = 0;
  cachedTelematicsMap = null;
  telematicsCacheTime = 0;
  ccCache.clear();
  ccTelematicsCache.clear();
}

module.exports = { getVideoSeverityMap, getTelematicsSeverityMap, invalidateCache };
