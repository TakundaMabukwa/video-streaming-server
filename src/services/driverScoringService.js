const { query, getClient } = require('../db');

let midnightInterval = null;

async function processAlertDeduction(fleet_number, alert_type) {
  if (!fleet_number || !alert_type) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Find matching criteria where alert_type is in statuses and nrc_deduction = false
    const criteriaResult = await client.query(
      `SELECT id, name, selected_weighting, incidents_threshold 
       FROM driver_config_criteria 
       WHERE is_active = true AND nrc_deduction = false 
       AND $1 = ANY(statuses)`,
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
  console.log('[DriverScoring] Initializing from vehiclesc + drivers...');
  
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Get vehicles with their drivers from Supabase tables
    const vehiclesResult = await client.query(`
      SELECT 
        v.fleet_number,
        v.registration_number,
        CONCAT(d.first_name, ' ', d.surname) as driver_name
      FROM vehiclesc v
      LEFT JOIN drivers d ON d.fleet_number = v.fleet_number
      WHERE v.fleet_number IS NOT NULL AND v.fleet_number != ''
    `);

    let synced = 0;
    for (const vehicle of vehiclesResult.rows) {
      const result = await client.query(`
        INSERT INTO driver_scoring (fleet_number, registration_number, driver, score, alert_types)
        VALUES ($1, $2, $3, 100, '[]'::jsonb)
        ON CONFLICT (fleet_number) DO UPDATE 
        SET registration_number = EXCLUDED.registration_number,
            driver = COALESCE(EXCLUDED.driver, driver_scoring.driver),
            updated_at = NOW()
        RETURNING id
      `, [vehicle.fleet_number, vehicle.registration_number, vehicle.driver_name]);

      if (result.rows.length > 0) synced++;
    }

    await client.query('COMMIT');
    console.log(`[DriverScoring] Initialized ${synced}/${vehiclesResult.rows.length} vehicles`);
    return { synced, total: vehiclesResult.rows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DriverScoring] Init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function syncNewVehicles() {
  console.log('[DriverScoring] Syncing new vehicles...');
  
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Get vehicles not in driver_scoring
    const vehiclesResult = await client.query(`
      SELECT 
        v.fleet_number,
        v.registration_number,
        CONCAT(d.first_name, ' ', d.surname) as driver_name
      FROM vehiclesc v
      LEFT JOIN drivers d ON d.fleet_number = v.fleet_number
      WHERE v.fleet_number IS NOT NULL 
        AND v.fleet_number != ''
        AND v.fleet_number NOT IN (SELECT fleet_number FROM driver_scoring WHERE fleet_number IS NOT NULL)
    `);

    let synced = 0;
    for (const vehicle of vehiclesResult.rows) {
      await client.query(`
        INSERT INTO driver_scoring (fleet_number, registration_number, driver, score, alert_types)
        VALUES ($1, $2, $3, 100, '[]'::jsonb)
      `, [vehicle.fleet_number, vehicle.registration_number, vehicle.driver_name]);
      synced++;
    }

    await client.query('COMMIT');
    if (synced > 0) {
      console.log(`[DriverScoring] Synced ${synced} new vehicles`);
    }
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
