const express = require('express');
const router = express.Router();
const { query, getClient } = require('../db');

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

    // Find criteria where alert_type is in statuses (case-insensitive) and nrc_deduction = false
    const criteriaResult = await query(
      `SELECT id, name, selected_weighting, incidents_threshold, nrc_deduction 
       FROM driver_config_criteria 
       WHERE is_active = true AND nrc_deduction = false 
       AND EXISTS (SELECT 1 FROM unnest(statuses) s WHERE LOWER(s) = LOWER($1))`,
      [alert_type]
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
      weighting: criteria.selected_weighting,
      incidents_threshold: criteria.incidents_threshold,
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

    // Get criteria weighting
    const criteriaResult = await query(
      'SELECT selected_weighting FROM driver_config_criteria WHERE id = $1',
      [criteria_id]
    );

    if (criteriaResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Criteria not found' });
    }

    const weighting = parseFloat(criteriaResult.rows[0].selected_weighting) || 0;

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

// POST /api/driver-scoring/increment - Increment alert count and deduct if threshold reached
router.post('/increment', async (req, res) => {
  try {
    const { fleet_number, alert_type } = req.body;
    if (!fleet_number || !alert_type) {
      return res.status(400).json({ success: false, message: 'fleet_number and alert_type required' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Find matching criteria
      const criteriaResult = await client.query(
        `SELECT id, name, selected_weighting, incidents_threshold 
         FROM driver_config_criteria 
         WHERE is_active = true AND nrc_deduction = false 
         AND $1 = ANY(statuses)`,
        [alert_type]
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

      res.json({
        success: true,
        deducted,
        new_score: newScore,
        current_count: alertEntry.count,
        weighting: deducted ? criteria.selected_weighting : 0
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
