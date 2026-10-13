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

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Verify user exists in our users table
    const { data: userRecord, error: userError } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', user.id)
      .single();

    if (userError || !userRecord) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    req.user = user;
    req.userRole = userRecord.role;
    req.userCostCenterIds = await getUserCostCenterIds(user.id, supabase);
    next();
  } catch (err) {
    console.error('[AUTH] Error:', err.message);
    return res.status(401).json({ success: false, message: 'Auth error' });
  }
}

module.exports = { requireAuth };
