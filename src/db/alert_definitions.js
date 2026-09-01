const db = require('./index');

let cachedMap = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedTelematicsMap = null;
let telematicsCacheTime = 0;

// Caches for cost-center-scoped maps (per cost-center key)
const ccCache = new Map(); // key -> { map, ts }
const ccTelematicsCache = new Map();

function cacheKeyFor(ids) {
  if (!ids || ids.length === 0) return 'global';
  return ids.slice().sort().join(',');
}

/**
 * Load video alert definitions and return a signal_code → severity map.
 * Results are cached in memory for 5 minutes.
 *
 * @param {number[]} [costCenterIds] - when provided, cost-center-specific
 *   definitions override global defaults for the matching signal codes.
 *   Empty/undefined returns only global (cost_center_id IS NULL) definitions.
 */
async function getVideoSeverityMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  // Use the existing fast path for the global map
  if (key === 'global') {
    const now = Date.now();
    if (cachedMap && now - cacheTime < CACHE_TTL_MS) {
      return cachedMap;
    }

    try {
      const result = await db.query(
        `SELECT signal_code, severity FROM alert_definitions WHERE category = 'video' AND is_active = true AND cost_center_id IS NULL`
      );

      const map = {};
      for (const row of result.rows) {
        if (row.signal_code) {
          map[row.signal_code] = (row.severity || 'MEDIUM').toLowerCase();
        }
      }

      cachedMap = map;
      cacheTime = now;
      return map;
    } catch (error) {
      console.error('[alert_definitions] Failed to load video severity map:', error.message);
      return cachedMap || {};
    }
  }

  // Cost-center-scoped map
  const now = Date.now();
  const cached = ccCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.map;
  }

  try {
    const result = await db.query(
      `SELECT signal_code, severity FROM alert_definitions
       WHERE category = 'video' AND is_active = true
       AND (cost_center_id IS NULL OR cost_center_id = ANY($1::int[]))
       ORDER BY cost_center_id IS NOT NULL`,
      [costCenterIds]
    );

    const map = {};
    for (const row of result.rows) {
      if (row.signal_code) {
        // Later iterations (cost-center-specific) override global
        map[row.signal_code] = (row.severity || 'MEDIUM').toLowerCase();
      }
    }

    ccCache.set(key, { map, ts: now });
    return map;
  } catch (error) {
    console.error('[alert_definitions] Failed to load CC video severity map:', error.message);
    return cached ? cached.map : {};
  }
}

/**
 * Load telematics alert definitions and return a signal_code → severity map.
 * Combines global defaults with cost-center-specific overrides when costCenterIds
 * are provided.
 */
async function getTelematicsSeverityMap(costCenterIds) {
  const key = cacheKeyFor(costCenterIds);

  if (key === 'global') {
    const now = Date.now();
    if (cachedTelematicsMap && now - telematicsCacheTime < CACHE_TTL_MS) {
      return cachedTelematicsMap;
    }

    try {
      const result = await db.query(
        `SELECT signal_code, severity FROM alert_definitions WHERE category = 'telematics' AND is_active = true AND cost_center_id IS NULL`
      );

      const map = {};
      for (const row of result.rows) {
        if (row.signal_code) {
          map[row.signal_code] = (row.severity || 'MEDIUM').toLowerCase();
        }
      }

      cachedTelematicsMap = map;
      telematicsCacheTime = now;
      return map;
    } catch (error) {
      console.error('[alert_definitions] Failed to load telematics severity map:', error.message);
      return cachedTelematicsMap || {};
    }
  }

  const now = Date.now();
  const cached = ccTelematicsCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.map;
  }

  try {
    const result = await db.query(
      `SELECT signal_code, severity FROM alert_definitions
       WHERE category = 'telematics' AND is_active = true
       AND (cost_center_id IS NULL OR cost_center_id = ANY($1::int[]))
       ORDER BY cost_center_id IS NOT NULL`,
      [costCenterIds]
    );

    const map = {};
    for (const row of result.rows) {
      if (row.signal_code) {
        map[row.signal_code] = (row.severity || 'MEDIUM').toLowerCase();
      }
    }

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