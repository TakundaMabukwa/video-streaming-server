const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchVehiclesFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[SUPABASE] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return [];
  }

  const url = `${SUPABASE_URL}/rest/v1/vehiclesc?select=fleet_number,registration_number,make,model,cost_center`;

  try {
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!response.ok) {
      console.error(`[SUPABASE] Fetch failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('[SUPABASE] Failed to fetch vehicles:', error.message);
    return [];
  }
}

module.exports = { fetchVehiclesFromSupabase };
