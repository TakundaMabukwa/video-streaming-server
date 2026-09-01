const { query } = require('../db');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// In-memory cache: key = `${table}:${cost_center_id}`, value = { data, ts }
const configCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

function cacheKey(table, costCenterId, matchBy = {}) {
  return `${table}:${costCenterId == null ? 'global' : costCenterId}:${JSON.stringify(matchBy)}`;
}

/*
 * Resolve configuration for a given table, preferring the cost-center-specific
 * row and falling back to the global (cost_center_id IS NULL) row.
 *
 * `table` expects a `cost_center_id` column. Resolves a single row by optional
 * `matchBy` (e.g. { name: 'X' } or { signal_code: 'Y' }).
 */
async function resolveConfig(table, costCenterId, matchBy = {}) {
  const key = cacheKey(table, costCenterId, matchBy);
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) {
    return matchFor(cached.data, matchBy);
  }

  const whereParts = [];
  const params = [];
  let paramIdx = 1;
  for (const [col, val] of Object.entries(matchBy)) {
    whereParts.push(`${col} = $${paramIdx}`);
    params.push(val);
    paramIdx++;
  }
  const whereClause = whereParts.length ? ` AND ${whereParts.join(' AND ')}` : '';

  let rows = [];
  try {
    const queryText = `SELECT * FROM ${table} WHERE is_active = true ${whereClause}`;
    const result = await query(queryText, params);
    rows = result.rows;
  } catch (err) {
    console.error(`[ConfigResolver] Query error for ${table}:`, err.message);
    return null;
  }

  const costCenterKey = cacheKey(table, costCenterId, matchBy);

  // Rows ordered CC-specific first, then global, so cached/find precedence is correct
  const cacheData = [...rows].sort(
    (a, b) => (a.cost_center_id === null ? 1 : 0) - (b.cost_center_id === null ? 1 : 0)
  );

  if (costCenterId != null) {
    // Try CC-specific first, fall back to the global row
    const resolvedRow =
      rows.find((r) => r.cost_center_id === costCenterId && matches(r, matchBy)) ||
      rows.find((r) => r.cost_center_id === null && matches(r, matchBy)) ||
      null;
    configCache.set(costCenterKey, { data: cacheData, ts: Date.now() });
    return resolvedRow;
  }

  // Global context: no cost_center_id provided, only global rows apply
  const resolvedRow =
    rows.find((r) => r.cost_center_id === null && matches(r, matchBy)) || null;
  configCache.set(costCenterKey, { data: cacheData.filter((r) => r.cost_center_id === null), ts: Date.now() });
  return resolvedRow;
}

function matches(row, matchBy) {
  for (const [col, val] of Object.entries(matchBy)) {
    if (row[col] !== val) return false;
  }
  return true;
}

function matchFor(cachedRows, matchBy) {
  if (!Array.isArray(cachedRows)) return null;
  return cachedRows.find(r => matches(r, matchBy)) || null;
}

/*
 * Sync cost centers from Supabase into the local cost_centers table.
 * Call once at midnight (cost centers rarely change).
 */
async function syncCostCenters() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { synced: 0, error: 'Supabase not configured' };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cost_centers?select=id,name,code,is_active`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) {
      console.error('[ConfigResolver] Failed to fetch cost centers:', res.status);
      return { synced: 0, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!Array.isArray(data)) return { synced: 0, error: 'Invalid response' };

    let synced = 0;
    for (const cc of data) {
      await query(
        `INSERT INTO cost_centers (id, name, code, is_active, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()`,
        [cc.id, cc.name || '', cc.code || '', cc.is_active !== false]
      );
      synced++;
    }
    console.log(`[ConfigResolver] Synced ${synced} cost centers from Supabase`);
    return { synced };
  } catch (err) {
    console.error('[ConfigResolver] syncCostCenters error:', err.message);
    return { synced: 0, error: err.message };
  }
}

function invalidateConfigCache(table) {
  for (const key of configCache.keys()) {
    if (key.startsWith(`${table}:`)) {
      configCache.delete(key);
    }
  }
}

module.exports = {
  resolveConfig,
  syncCostCenters,
  invalidateConfigCache,
};
