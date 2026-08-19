const db = require('./index');

let cachedMap = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load video alert definitions and return a signal_code → severity map.
 * Results are cached in memory for 5 minutes.
 * Returns { fatigueAlarm: 'CRITICAL', bang: 'CRITICAL', ... }
 */
async function getVideoSeverityMap() {
  const now = Date.now();
  if (cachedMap && now - cacheTime < CACHE_TTL_MS) {
    return cachedMap;
  }

  try {
    const result = await db.query(
      `SELECT signal_code, severity FROM alert_definitions WHERE category = 'video' AND is_active = true`
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

function invalidateCache() {
  cachedMap = null;
  cacheTime = 0;
}

module.exports = { getVideoSeverityMap, invalidateCache };
