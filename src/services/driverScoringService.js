const { query, getClient } = require('../db');
const { fetchVehiclesFromSupabase } = require('../helpers/supabaseClient');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let midnightInterval = null;

async function fetchDriversFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const url = `${SUPABASE_URL}/rest/v1/drivers?select=id,first_name,surname,fleet_number&fleet_number=not.is.null`;
  try {
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function fetchVehiclesWithDrivers() {
  const [vehicles, drivers] = await Promise.all([
    fetchVehiclesFromSupabase(),
    fetchDriversFromSupabase()
  ]);

  const driverMap = new Map();
  for (const d of drivers) {
    if (d.fleet_number) driverMap.set(d.fleet_number.toUpperCase(), `${d.first_name || ''} ${d.surname || ''}`.trim());
  }

  return vehicles
    .filter(v => v.fleet_number && v.fleet_number.trim())
    .map(v => ({
      fleet_number: v.fleet_number,
      registration_number: v.registration_number || '',
      driver_name: driverMap.get(v.fleet_number.toUpperCase()) || null
    }));
}

async function processAlertDeduction(fleet_number, alert_type) {
  if (!fleet_number || !alert_type) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Find matching criteria where alert_type is in statuses (case-insensitive) and nrc_deduction = false
    const criteriaResult = await client.query(
      `SELECT id, name, selected_weighting, incidents_threshold 
       FROM driver_config_criteria 
       WHERE is_active = true AND nrc_deduction = false 
       AND EXISTS (SELECT 1 FROM unnest(statuses) s WHERE LOWER(s) = LOWER($1))`,
      [alert_type]
    );

    if (criteriaResult.rows.length === 0) {
      await client.query('COMMIT');
      return { deducted: false, reason: 'no_matching_criteria' };
    }

    const criteria = criteriaResult.rows[0];

    // Lock the row for update
    const scoringResult = await client.query(
      'SELECT id, score, alert_types FROM driver_scoring WHERE fleet_number = $1 FOR UPDATE',
      [fleet_number]
    );

    if (scoringResult.rows.length === 0) {
      await client.query('COMMIT');
      return { deducted: false, reason: 'no_scoring_record' };
    }

    let scoring = scoringResult.rows[0];
    let alertTypes = scoring.alert_types || [];
    let alertEntry = alertTypes.find(a => a.alert_name === alert_type);

    if (!alertEntry) {
      alertEntry = { alert_name: alert_type, count: 0 };
      alertTypes.push(alertEntry);
    }

    alertEntry.count += 1;
    let deducted = false;
    let newScore = scoring.score;

    if (alertEntry.count >= criteria.incidents_threshold) {
      const weighting = parseFloat(criteria.selected_weighting) || 0;
      newScore = Math.max(newScore - weighting, 0);
      alertEntry.count = 0;
      deducted = true;
    }

    // Update driver_scoring
    await client.query(
      `UPDATE driver_scoring 
       SET score = $1, alert_types = $2, updated_at = NOW() 
       WHERE fleet_number = $3`,
      [newScore, JSON.stringify(alertTypes), fleet_number]
    );

    await client.query('COMMIT');

    return {
      deducted,
      new_score: newScore,
      current_count: alertEntry.count,
      weighting: deducted ? criteria.selected_weighting : 0
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DriverScoring] processAlertDeduction error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function initializeDriverScoring() {
  console.log('[DriverScoring] Initializing from Supabase (vehiclesc + drivers)...');

  const vehicles = await fetchVehiclesWithDrivers();
  if (vehicles.length === 0) {
    console.log('[DriverScoring] No vehicles found in Supabase');
    return { synced: 0, total: 0 };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    let synced = 0;
    for (const v of vehicles) {
      const result = await client.query(`
        INSERT INTO driver_scoring (fleet_number, registration_number, driver, score, alert_types)
        VALUES ($1, $2, $3, 100, '[]'::jsonb)
        ON CONFLICT (fleet_number) DO UPDATE 
        SET registration_number = EXCLUDED.registration_number,
            driver = COALESCE(EXCLUDED.driver, driver_scoring.driver),
            updated_at = NOW()
        RETURNING id
      `, [v.fleet_number, v.registration_number, v.driver_name]);

      if (result.rows.length > 0) synced++;
    }

    await client.query('COMMIT');
    console.log(`[DriverScoring] Initialized ${synced}/${vehicles.length} vehicles`);
    return { synced, total: vehicles.length };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DriverScoring] Init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function syncNewVehicles() {
  console.log('[DriverScoring] Syncing new vehicles from Supabase...');

  const vehicles = await fetchVehiclesWithDrivers();
  if (vehicles.length === 0) return 0;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existingResult = await client.query('SELECT fleet_number FROM driver_scoring');
    const existingSet = new Set(existingResult.rows.map(r => r.fleet_number));

    let synced = 0;
    for (const v of vehicles) {
      if (existingSet.has(v.fleet_number)) continue;
      await client.query(`
        INSERT INTO driver_scoring (fleet_number, registration_number, driver, score, alert_types)
        VALUES ($1, $2, $3, 100, '[]'::jsonb)
      `, [v.fleet_number, v.registration_number, v.driver_name]);
      synced++;
    }

    await client.query('COMMIT');
    if (synced > 0) console.log(`[DriverScoring] Synced ${synced} new vehicles`);
    return synced;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DriverScoring] Sync error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

function startMidnightCron() {
  if (midnightInterval) return;

  // Calculate ms until next midnight
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  // Set initial timeout
  setTimeout(() => {
    syncNewVehicles().catch(console.error);
    
    // Then run every 24 hours
    midnightInterval = setInterval(() => {
      syncNewVehicles().catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log(`[DriverScoring] Midnight cron scheduled (${Math.round(msUntilMidnight / 1000 / 60)} min until first run)`);
}

function stopMidnightCron() {
  if (midnightInterval) {
    clearInterval(midnightInterval);
    midnightInterval = null;
    console.log('[DriverScoring] Midnight cron stopped');
  }
}

module.exports = {
  initializeDriverScoring,
  syncNewVehicles,
  startMidnightCron,
  stopMidnightCron,
  processAlertDeduction
};
