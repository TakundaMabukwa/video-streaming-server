const express = require('express');
const db = require('../db');

const router = express.Router();

// Get all driver config criteria
router.get('/criteria', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM driver_config_criteria ORDER BY name ASC'
    );
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
    const { name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    const result = await db.query(
      `INSERT INTO driver_config_criteria (name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        name,
        selected_weighting || 10,
        actual_weighting || selected_weighting || 10,
        risk_tiers || 4,
        no_incidents || 0,
        statuses || [],
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
    const { name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, is_active } = req.body;

    const result = await db.query(
      `UPDATE driver_config_criteria
       SET name = COALESCE($1, name),
           selected_weighting = COALESCE($2, selected_weighting),
           actual_weighting = COALESCE($3, actual_weighting),
           risk_tiers = COALESCE($4, risk_tiers),
           no_incidents = COALESCE($5, no_incidents),
           statuses = COALESCE($6, statuses),
           is_active = COALESCE($7, is_active),
           updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, is_active, id]
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
