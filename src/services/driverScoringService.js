const { query, getClient } = require('../db');
const { fetchVehiclesFromSupabase } = require('../helpers/supabaseClient');
const { findVehicleCostCenterId } = require('./costCenterLookup');
const { syncCostCenters } = require('./configResolver');

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

  // Resolve cost center names/codes to local cost_center ids
  const ccResult = await query('SELECT id, name, code FROM cost_centers');
  const ccMap = new Map();
  for (const cc of ccResult.rows) {
    if (cc.name) ccMap.set(String(cc.name).toLowerCase(), cc.id);
    if (cc.code) ccMap.set(String(cc.code).toLowerCase(), cc.id);
  }

  const driverMap = new Map();
  for (const d of drivers) {
    if (d.fleet_number) driverMap.set(d.fleet_number.toUpperCase(), `${d.first_name || ''} ${d.surname || ''}`.trim());
  }

  return vehicles
    .filter(v => v.fleet_number && v.fleet_number.trim())
    .map(v => ({
      fleet_number: v.fleet_number,
      registration_number: v.registration_number || '',
      driver_name: driverMap.get(v.fleet_number.toUpperCase()) || null,
      cost_center_id: (v.cost_center && ccMap.get(String(v.cost_center).toLowerCase())) || null
    }));
}

async function processAlertDeduction(fleet_number, alert_type) {
  if (!fleet_number || !alert_type) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Determine the vehicle's cost center (NULL = use global config)
    const vehicleCostCenterId = await findVehicleCostCenterId(fleet_number);

    // Find matching criteria — resolve group first, then CC-specific, then global
    const criteriaResult = await client.query(
      `SELECT id, name, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id, config_group_id
       FROM driver_config_criteria
       WHERE is_active = true
       AND (
         config_group_id IN (SELECT group_id FROM config_group_members WHERE cost_center_id = $2)
         OR cost_center_id = $2
         OR (config_group_id IS NULL AND cost_center_id IS NULL)
       )
       AND EXISTS (SELECT 1 FROM unnest(statuses) s WHERE LOWER(s) = LOWER($1))
       ORDER BY
         CASE WHEN config_group_id IS NOT NULL THEN 1
              WHEN cost_center_id IS NOT NULL THEN 2
              ELSE 3 END
       LIMIT 1`,
      [alert_type, vehicleCostCenterId == null ? 0 : vehicleCostCenterId]
    );

    if (criteriaResult.rows.length === 0) {
      console.log(`[DriverScoring] No matching criteria for fleet=${fleet_number} alert=${alert_type} cc=${vehicleCostCenterId}`);
      await client.query('COMMIT');
      return { deducted: false, reason: 'no_matching_criteria' };
    }

    const criteria = criteriaResult.rows[0];

    // Lock the scoring row for update
    const scoringResult = await client.query(
      'SELECT id, score, alert_types FROM driver_scoring WHERE fleet_number = $1 FOR UPDATE',
      [fleet_number]
    );

    if (scoringResult.rows.length === 0) {
      console.log(`[DriverScoring] No scoring record for fleet=${fleet_number}`);
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

    // Increment count
    alertEntry.count += 1;

    // Always deduct per-alert points
    const perAlertDeduction = parseFloat(criteria.deduction_per_alert) || 0;
    let newScore = Math.max(scoring.score - perAlertDeduction, 0);
    let ncrCreated = false;

    // Check if NCR threshold reached
    const ncrThreshold = criteria.ncr_threshold || 3;
    if (alertEntry.count >= ncrThreshold) {
      // Create NCR alert in alerts table
      try {
        const ncrId = `ncr-${fleet_number}-${alert_type}-${Date.now()}`;
        const now = new Date().toISOString();
        await client.query(
          `INSERT INTO alerts (id, device_id, alarm_type, alarm_ts, source_type, status, resolved, false_alert, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'telematics', 'new', false, false, $5, $4, $4)
           ON CONFLICT (id) DO NOTHING`,
          [ncrId, fleet_number, `NCR: ${alert_type}`, now, `Auto-generated NCR after ${alertEntry.count} ${alert_type} alerts`]
        );

        // Create alert_group for the NCR
        const groupKey = `${fleet_number}:NCR: ${alert_type}`;
        await client.query(
          `INSERT INTO alert_groups (group_key, device_id, alarm_type, count, last_alert_id, last_alert_ts, source_type, status, resolved, false_alert, created_at, updated_at)
           VALUES ($1, $2, $3, 1, $4, $4, 'telematics', 'new', false, false, $4, $4)
           ON CONFLICT (group_key) DO UPDATE SET
             count = alert_groups.count + 1,
             last_alert_id = EXCLUDED.last_alert_id,
             last_alert_ts = EXCLUDED.last_alert_ts,
             updated_at = NOW()`,
          [groupKey, fleet_number, `NCR: ${alert_type}`, ncrId]
        );

        ncrCreated = true;
        // Reset count after NCR
        alertEntry.count = 0;

        // Auto-close the original telematics alerts that triggered this NCR.
        // The original alerts use the Geotab device_id, not the fleet_number,
        // so we resolve it from geotab_devices.
        try {
          const devResult = await client.query(
            `SELECT id FROM geotab_devices WHERE UPPER(fleet_number) = UPPER($1) LIMIT 1`,
            [fleet_number]
          );
          if (devResult.rows.length > 0) {
            const origDeviceId = devResult.rows[0].id;
            const origGroupKey = `${origDeviceId}:${alert_type}`.toLowerCase();
            await client.query(
              `UPDATE alert_groups SET resolved = TRUE, resolved_by = 'SYSTEM', resolved_at = NOW(), notes = COALESCE(notes || ' | ', '') || 'Auto-closed: NCR threshold reached', updated_at = NOW()
               WHERE group_key = $1 AND resolved = FALSE`,
              [origGroupKey]
            );
            await client.query(
              `UPDATE alerts SET resolved = TRUE, updated_at = NOW()
               WHERE device_id = $1 AND alarm_type = $2 AND resolved = FALSE`,
              [origDeviceId, alert_type]
            );
            console.log(`[DriverScoring] Auto-closed original alerts for fleet=${fleet_number} device=${origDeviceId} type=${alert_type}`);
          }
        } catch (closeErr) {
          console.error('[DriverScoring] Failed to auto-close original alerts:', closeErr.message);
        }

        // Capture incident register row for the auto-NCR
        try {
          await insertAutoIncident(client, {
            alertId: ncrId,
            fleetNumber: fleet_number,
            alarmType: `NCR: ${alert_type}`,
            costCenterId: vehicleCostCenterId,
          });
        } catch (incErr) {
          console.error('[DriverScoring] Failed to capture auto-incident:', incErr.message);
        }
      } catch (ncrErr) {
        console.error('[DriverScoring] Failed to create NCR alert:', ncrErr.message);
      }
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
      deducted: true,
      new_score: newScore,
      current_count: alertEntry.count,
      weighting: perAlertDeduction,
      ncr_created: ncrCreated,
      ncr_threshold: ncrThreshold,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DriverScoring] processAlertDeduction error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Insert an OPEN incident register row for an auto-generated NCR (uses caller's transaction client).
async function insertAutoIncident(client, { alertId, fleetNumber, alarmType, costCenterId, sourceType = 'telematics' }) {
  await client.query(
    `INSERT INTO incidents (
       incident_no, alert_id, alarm_type, source_type, device_id, fleet_number, cost_center_id,
       week, shift, incident_date, incident_time, infringement, filled_by, status
     ) VALUES (
       DEFAULT, $1, $2, $3, $4, $5, $6,
       EXTRACT(WEEK FROM NOW())::int, to_char(NOW(), 'HH24:MI'), CURRENT_DATE, NOW()::time, $2, 'SYSTEM', 'OPEN'
     )
     ON CONFLICT (alert_id) DO NOTHING`,
    [alertId, alarmType, sourceType, fleetNumber, fleetNumber, costCenterId]
  );
}

// Apply the one-time NCR deduction (deduction_with_ncr) for a closed NCR incident.
// Gated by nrc_deduction on the CC-aware driver_config_criteria row.
async function applyNcrDeduction(fleet_number, alertType) {
  if (!fleet_number) return { deducted: false, reason: 'no_fleet' };

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const vehicleCostCenterId = await findVehicleCostCenterId(fleet_number);
    const baseType = String(alertType || '').replace(/^NCR:\s*/i, '');

    // Prefer a criterion matching the original alert type; fall back to any NCR-enabled criterion for the CC.
    const criteriaResult = await client.query(
      `SELECT id, name, deduction_with_ncr, nrc_deduction, cost_center_id, config_group_id
       FROM driver_config_criteria
       WHERE is_active = true
       AND (
         config_group_id IN (SELECT group_id FROM config_group_members WHERE cost_center_id = $2)
         OR cost_center_id = $2
         OR (config_group_id IS NULL AND cost_center_id IS NULL)
       )
       AND (EXISTS (SELECT 1 FROM unnest(statuses) s WHERE LOWER(s) = LOWER($1))
            OR nrc_deduction = true)
       ORDER BY
         (EXISTS (SELECT 1 FROM unnest(statuses) s WHERE LOWER(s) = LOWER($1))) DESC,
         CASE WHEN config_group_id IS NOT NULL THEN 1
              WHEN cost_center_id IS NOT NULL THEN 2
              ELSE 3 END
       LIMIT 1`,
      [baseType, vehicleCostCenterId == null ? 0 : vehicleCostCenterId]
    );

    const criteria = criteriaResult.rows[0];
    if (!criteria || !criteria.nrc_deduction) {
      await client.query('COMMIT');
      return { deducted: false, reason: 'no_criteria_or_nrc_disabled' };
    }

    const weighting = parseFloat(criteria.deduction_with_ncr) || 0;
    if (weighting <= 0) {
      await client.query('COMMIT');
      return { deducted: false, reason: 'zero_weighting', weighting };
    }

    const result = await client.query(
      `UPDATE driver_scoring
       SET score = GREATEST(score - $1, 0), updated_at = NOW()
       WHERE fleet_number = $2
       RETURNING id, score`,
      [weighting, fleet_number]
    );

    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return { deducted: false, reason: 'no_scoring_record', weighting };
    }

    return { deducted: true, new_score: result.rows[0].score, weighting };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DriverScoring] applyNcrDeduction error:', err.message);
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
        INSERT INTO driver_scoring (fleet_number, registration_number, driver, score, alert_types, cost_center_id)
        VALUES ($1, $2, $3, 100, '[]'::jsonb, $4)
        ON CONFLICT (fleet_number) DO UPDATE 
        SET registration_number = EXCLUDED.registration_number,
            driver = COALESCE(EXCLUDED.driver, driver_scoring.driver),
            cost_center_id = COALESCE(EXCLUDED.cost_center_id, driver_scoring.cost_center_id),
            updated_at = NOW()
        RETURNING id
      `, [v.fleet_number, v.registration_number, v.driver_name, v.cost_center_id]);

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
        INSERT INTO driver_scoring (fleet_number, registration_number, driver, score, alert_types, cost_center_id)
        VALUES ($1, $2, $3, 100, '[]'::jsonb, $4)
      `, [v.fleet_number, v.registration_number, v.driver_name, v.cost_center_id]);
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
    syncCostCenters().catch(console.error);
    syncNewVehicles().catch(console.error);
    
    // Then run every 24 hours
    midnightInterval = setInterval(() => {
      syncCostCenters().catch(console.error);
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
  processAlertDeduction,
  applyNcrDeduction,
  insertAutoIncident,
};
