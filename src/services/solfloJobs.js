const axios = require('axios');

let cachedToken = null;
let cachedExpiryMs = 0;

function getConfig() {
  const baseUrl = String(process.env.SOLFLO_JOB_API_BASE_URL || '').trim().replace(/\/$/, '');
  const supabaseUrl = String(process.env.SOLFLO_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const anonKey = String(process.env.SOLFLO_SUPABASE_ANON_KEY || '').trim();
  const email = String(process.env.SOLFLO_API_EMAIL || '').trim();
  const password = String(process.env.SOLFLO_API_PASSWORD || '');
  const defaultAccountCode = String(process.env.SOLFLO_DEFAULT_ACCOUNT_CODE || 'SRS-0001').trim();
  return { baseUrl, supabaseUrl, anonKey, email, password, defaultAccountCode };
}

function isConfigured() {
  const c = getConfig();
  return Boolean(c.baseUrl && c.supabaseUrl && c.anonKey && c.email && c.password);
}

async function getSolfloToken(forceRefresh = false) {
  const { supabaseUrl, anonKey, email, password } = getConfig();
  if (!supabaseUrl || !anonKey || !email || !password) {
    throw new Error('Solflo API is not configured (missing SOLFLO_SUPABASE_URL / ANON_KEY / EMAIL / PASSWORD)');
  }
  const now = Date.now();
  if (!forceRefresh && cachedToken && now < cachedExpiryMs - 60000) return cachedToken;

  const url = `${supabaseUrl}/auth/v1/token?grant_type=password`;
  const res = await axios.post(
    url,
    { email, password },
    { headers: { apikey: anonKey, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  const token = res.data?.access_token;
  const expiresIn = Number(res.data?.expires_in || 3600);
  if (!token) throw new Error('Solflo login failed (no access_token)');
  cachedToken = token;
  cachedExpiryMs = now + expiresIn * 1000;
  return cachedToken;
}

async function createSolfloJob({ vehicle_reg, job_description, priority = 'medium', account_code }) {
  const { baseUrl, defaultAccountCode } = getConfig();
  if (!baseUrl) throw new Error('Solflo API is not configured (missing SOLFLO_JOB_API_BASE_URL)');

  const reg = String(vehicle_reg || '').trim();
  const desc = String(job_description || '').trim();
  if (!reg) {
    const e = new Error('vehicle_reg is required');
    e.statusCode = 400;
    throw e;
  }
  if (!desc) {
    const e = new Error('job_description is required');
    e.statusCode = 400;
    throw e;
  }

  const body = {
    vehicle_reg: reg,
    job_description: desc,
    priority: ['low', 'medium', 'high'].includes(String(priority).toLowerCase())
      ? String(priority).toLowerCase()
      : 'medium',
    account_code: String(account_code || defaultAccountCode || 'SRS-0001').trim(),
  };

  const attempt = async (token) =>
    axios.post(`${baseUrl}/api/job-cards/external`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

  try {
    const token = await getSolfloToken();
    try {
      const res = await attempt(token);
      return res.data;
    } catch (err) {
      if (err.response?.status === 401) {
        const fresh = await getSolfloToken(true);
        const res = await attempt(fresh);
        return res.data;
      }
      throw err;
    }
  } catch (err) {
    const status = err.response?.status;
    const msg =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Failed to create job';
    const e = new Error(msg);
    e.statusCode = status || err.statusCode || 500;
    e.details = err.response?.data || null;
    throw e;
  }
}

module.exports = { getConfig, isConfigured, getSolfloToken, createSolfloJob };
