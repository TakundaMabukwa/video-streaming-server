const express = require('express');
const db = require('../db');

const router = express.Router();

// Get global-only criteria (cost_center_id IS NULL)
router.get('/criteria/global', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM driver_config_criteria WHERE cost_center_id IS NULL ORDER BY name ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get criteria for a specific cost center (CC-specific only, no globals)
router.get('/criteria/for-cc/:costCenterId', async (req, res) => {
  try {
    const { costCenterId } = req.params;
    const result = await db.query(
      'SELECT * FROM driver_config_criteria WHERE cost_center_id = $1 ORDER BY name ASC',
      [Number(costCenterId)]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all driver config criteria
router.get('/criteria', async (req, res) => {
  try {
    const { cost_center_id } = req.query;
    let result;
    if (cost_center_id) {
      // Support comma-separated IDs: "1,2,3"
      const ccIds = cost_center_id.split(',').map(Number).filter(n => !isNaN(n));
      if (ccIds.length === 1) {
        result = await db.query(
          `SELECT * FROM driver_config_criteria
           WHERE cost_center_id IS NULL OR cost_center_id = $1
           ORDER BY cost_center_id IS NOT NULL, name ASC`,
          [ccIds[0]]
        );
      } else if (ccIds.length > 1) {
        result = await db.query(
          `SELECT * FROM driver_config_criteria
           WHERE cost_center_id IS NULL OR cost_center_id = ANY($1::int[])
           ORDER BY cost_center_id IS NOT NULL, name ASC`,
          [ccIds]
        );
      } else {
        result = await db.query(
          'SELECT * FROM driver_config_criteria WHERE cost_center_id IS NULL ORDER BY name ASC'
        );
      }
    } else {
      result = await db.query(
        'SELECT * FROM driver_config_criteria WHERE cost_center_id IS NULL ORDER BY name ASC'
      );
    }
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get single criterion
router.get('/criteria/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM driver_config_criteria WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Criterion not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create criterion
router.post('/criteria', async (req, res) => {
  try {
    const { name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    const result = await db.query(
      `INSERT INTO driver_config_criteria (name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        name,
        selected_weighting || deduction_per_alert || 10,
        actual_weighting || selected_weighting || deduction_per_alert || 10,
        risk_tiers || 4,
        no_incidents || 0,
        statuses || [],
        nrc_deduction || false,
        incidents_threshold || 1,
        deduction_per_alert || selected_weighting || 10,
        deduction_with_ncr || 0,
        ncr_threshold || 3,
        cost_center_id || null,
      ]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Criterion with this name already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update criterion
router.put('/criteria/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, is_active, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id } = req.body;

    const result = await db.query(
      `UPDATE driver_config_criteria
       SET name = COALESCE($1, name),
           selected_weighting = COALESCE($2, selected_weighting),
           actual_weighting = COALESCE($3, actual_weighting),
           risk_tiers = COALESCE($4, risk_tiers),
           no_incidents = COALESCE($5, no_incidents),
           statuses = COALESCE($6, statuses),
           is_active = COALESCE($7, is_active),
           nrc_deduction = COALESCE($8, nrc_deduction),
           incidents_threshold = COALESCE($9, incidents_threshold),
           deduction_per_alert = COALESCE($10, deduction_per_alert),
           deduction_with_ncr = COALESCE($11, deduction_with_ncr),
           ncr_threshold = COALESCE($12, ncr_threshold),
           cost_center_id = $13,
           updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, is_active, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Criterion not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Criterion with this name already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete criterion
router.delete('/criteria/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'DELETE FROM driver_config_criteria WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Criterion not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
