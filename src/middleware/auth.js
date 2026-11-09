const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabaseAdmin = null;

function getSupabaseAdmin() {
  if (!supabaseAdmin && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabaseAdmin;
}

// Cache for user cost center IDs (per user, 5-min TTL)
const userCostCenterCache = new Map();
const CC_CACHE_TTL = 5 * 60 * 1000;

// Per-token auth cache (60s TTL). The board polls ~6-10 endpoints every 15s;
// without this, EVERY proxied request made two Supabase round-trips
// (auth.getUser + users select), flooding the auth rate limit for the whole
// droplet IP — including logins. Keyed by the bearer token itself; entries
// die with the TTL so role/revocation changes apply within a minute.
const AUTH_CACHE_TTL = 60 * 1000;
const authCache = new Map(); // token -> { user, role, ccIds, expiresAt }

function jwtExpMs(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function sweepAuthCache() {
  const now = Date.now();
  for (const [key, entry] of authCache) {
    if (entry.expiresAt <= now) authCache.delete(key);
  }
}

async function getUserCostCenterIds(userId, supabase) {
  const cached = userCostCenterCache.get(userId);
  if (cached && Date.now() - cached.ts < CC_CACHE_TTL) return cached.ids;

  try {
    const { data } = await supabase
      .from('user_cost_centers')
      .select('cost_center_id')
      .eq('user_id', userId);
    const ids = (data || []).map(uc => uc.cost_center_id).filter(Boolean);
    userCostCenterCache.set(userId, { ids, ts: Date.now() });
    return ids;
  } catch (err) {
    console.error('[AUTH] Failed to fetch user cost centers:', err.message);
    return cached ? cached.ids : [];
  }
}

async function requireAuth(req, res, next) {
  // Every /api caller authenticates as a user: Supabase JWT via
  // Authorization: Bearer <token> (preferred) or access_token cookie.
  // There is no shared-key bypass — service-to-service callers must
  // forward the calling user's token.
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error('[AUTH] Supabase not configured');
    return res.status(500).json({ success: false, message: 'Auth not configured' });
  }

  // Extract token from Authorization header or cookie
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }
  if (!token && req.cookies) {
    token = req.cookies['access_token'];
  }
  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  // An expired JWT can never be served from cache (defense in depth even if
  // a stale entry somehow survived the TTL).
  const exp = jwtExpMs(token);
  if (exp && exp <= Date.now()) {
    return res.status(401).json({ success: false, message: 'Token expired' });
  }

  const cached = authCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    req.user = cached.user;
    req.userRole = cached.role;
    req.userCostCenterIds = cached.ccIds;
    req.userPermissions = cached.permissions || [];
    return next();
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      authCache.delete(token);
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Verify user exists in our users table
    const { data: userRecord, error: userError } = await supabase
      .from('users')
      .select('id, role, permissions')
      .eq('id', user.id)
      .single();

    if (userError || !userRecord) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    const ccIds = await getUserCostCenterIds(user.id, supabase);
    sweepAuthCache();
    authCache.set(token, {
      user,
      role: userRecord.role,
      ccIds,
      permissions: Array.isArray(userRecord.permissions) ? userRecord.permissions : [],
      // Never outlive the JWT itself.
      expiresAt: Math.min(Date.now() + AUTH_CACHE_TTL, exp || Infinity),
    });
    req.user = user;
    req.userRole = userRecord.role;
    req.userCostCenterIds = ccIds;
    req.userPermissions = Array.isArray(userRecord.permissions) ? userRecord.permissions : [];
    next();
  } catch (err) {
    console.error('[AUTH] Error:', err.message);
    return res.status(401).json({ success: false, message: 'Auth error' });
  }
}

module.exports = { requireAuth };
