const express = require('express');
const router = express.Router();
const { query, getClient } = require('../db');
const { findVehicleCostCenterId } = require('../services/costCenterLookup');

// GET /api/driver-scoring - Get all driver scores
router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, registration_number, fleet_number, driver, score, alert_types, created_at, updated_at FROM driver_scoring ORDER BY fleet_number'
    );
    res.json({ success: true, scores: result.rows });
  } catch (err) {
    console.error('[DriverScoring] Get all error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/driver-scoring/lookup - Check if alert qualifies for deduction
// Query: ?fleet_number=x&alert_type=x
router.get('/lookup', async (req, res) => {
  try {
    const { fleet_number, alert_type } = req.query;
    if (!fleet_number || !alert_type) {
      return res.status(400).json({ success: false, message: 'fleet_number and alert_type required' });
    }

    // Determine the vehicle's cost center (NULL = use global config)
    const vehicleCostCenterId = await findVehicleCostCenterId(fleet_number);

    // Find criteria where alert_type is in statuses (case-insensitive),
    // preferring group-based, then cost-center-specific, then global
    const criteriaResult = await query(
      `SELECT id, name, deduction_per_alert, deduction_with_ncr, ncr_threshold, incidents_threshold, cost_center_id, config_group_id
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
      return res.json({ success: true, eligible: false, reason: 'no_matching_criteria' });
    }

    const criteria = criteriaResult.rows[0];

    // Get current scoring for this fleet
    const scoringResult = await query(
      'SELECT id, score, alert_types FROM driver_scoring WHERE fleet_number = $1',
      [fleet_number]
    );

    if (scoringResult.rows.length === 0) {
      return res.json({ success: true, eligible: false, reason: 'no_scoring_record' });
    }

    const scoring = scoringResult.rows[0];
    const alertTypes = scoring.alert_types || [];
    const alertEntry = alertTypes.find(a => a.alert_name === alert_type);
    const currentCount = alertEntry ? alertEntry.count : 0;

    res.json({
      success: true,
      eligible: true,
      criteria_id: criteria.id,
      deduction_per_alert: parseFloat(criteria.deduction_per_alert) || 0,
      deduction_with_ncr: parseFloat(criteria.deduction_with_ncr) || 0,
      ncr_threshold: criteria.ncr_threshold || 3,
      incidents_threshold: criteria.incidents_threshold || 1,
      current_count: currentCount,
      score: scoring.score
    });
  } catch (err) {
    console.error('[DriverScoring] Lookup error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/driver-scoring/deduct - Deduct score (for NCR saves)
router.post('/deduct', async (req, res) => {
  try {
    const { fleet_number, criteria_id } = req.body;
    if (!fleet_number || !criteria_id) {
      return res.status(400).json({ success: false, message: 'fleet_number and criteria_id required' });
    }

    // Get criteria NCR deduction amount
    const criteriaResult = await query(
      'SELECT deduction_with_ncr FROM driver_config_criteria WHERE id = $1',
      [criteria_id]
    );

    if (criteriaResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Criteria not found' });
    }

    const weighting = parseFloat(criteriaResult.rows[0].deduction_with_ncr) || 0;

    // Deduct from score
    const result = await query(
      `UPDATE driver_scoring
       SET score = GREATEST(score - $1, 0), updated_at = NOW()
       WHERE fleet_number = $2
       RETURNING score`,
      [weighting, fleet_number]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fleet not found' });
    }

    res.json({ success: true, new_score: result.rows[0].score, deducted: weighting });
  } catch (err) {
    console.error('[DriverScoring] Deduct error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/driver-scoring/increment - Increment alert count and deduct per-alert points
router.post('/increment', async (req, res) => {
  try {
    const { fleet_number, alert_type } = req.body;
    if (!fleet_number || !alert_type) {
      return res.status(400).json({ success: false, message: 'fleet_number and alert_type required' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Find matching criteria (group-aware, cost-center-aware)
      const vehicleCostCenterId = await findVehicleCostCenterId(fleet_number);
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
        await client.query('COMMIT');
        return res.json({ success: true, deducted: false, reason: 'no_matching_criteria' });
      }

      const criteria = criteriaResult.rows[0];

      // Lock the row for update
      const scoringResult = await client.query(
        'SELECT id, score, alert_types FROM driver_scoring WHERE fleet_number = $1 FOR UPDATE',
        [fleet_number]
      );

      if (scoringResult.rows.length === 0) {
        await client.query('COMMIT');
        return res.json({ success: true, deducted: false, reason: 'no_scoring_record' });
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

          // Capture incident register row for the auto-NCR
          try {
            const { insertAutoIncident } = require('../services/driverScoringService');
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

      res.json({
        success: true,
        deducted: true,
        new_score: newScore,
        current_count: alertEntry.count,
        weighting: perAlertDeduction,
        ncr_created: ncrCreated,
        ncr_threshold: ncrThreshold,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[DriverScoring] Increment error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/driver-scoring/init - Initialize/sync all vehicles and drivers into driver_scoring
router.post('/init', async (req, res) => {
  try {
    const { initializeDriverScoring } = require('../services/driverScoringService');
    const result = await initializeDriverScoring();
    res.json({ success: true, count: result.synced, total: result.total });
  } catch (err) {
    console.error('[DriverScoring] Init error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/driver-scoring/sync - Add only new vehicles not in driver_scoring
router.post('/sync', async (req, res) => {
  try {
    const { syncNewVehicles } = require('../services/driverScoringService');
    const synced = await syncNewVehicles();
    res.json({ success: true, count: synced });
  } catch (err) {
    console.error('[DriverScoring] Sync error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
