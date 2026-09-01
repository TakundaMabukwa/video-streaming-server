const express = require('express');
const { query, getClient } = require('../db');

const router = express.Router();

// GET /api/rtms/rules - Get all RTMS rules
router.get('/rules', async (req, res) => {
  try {
    const { cost_center_id } = req.query;
    let result;
    if (cost_center_id) {
      const ccId = Number(cost_center_id);
      result = await query(
        `SELECT * FROM rtms_rules
         WHERE cost_center_id IS NULL OR cost_center_id = $1
         ORDER BY cost_center_id IS NOT NULL, module, rule_name`,
        [ccId]
      );
    } else {
      result = await query(
        'SELECT * FROM rtms_rules WHERE cost_center_id IS NULL ORDER BY module, rule_name'
      );
    }
    res.json({ success: true, rules: result.rows });
  } catch (err) {
    console.error('[RTMS] Get rules error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/rtms/rules - Create or bulk upsert rules
router.post('/rules', async (req, res) => {
  try {
    const { rules, cost_center_id } = req.body;

    // Single rule creation with duplicate check
    if (!Array.isArray(rules) && req.body.rule_name) {
      const { module, rule_name, system_constraint, audit_focus, max_value, min_value, unit, enabled } = req.body;
      const ccId = cost_center_id || null;
      const existing = await query(
        'SELECT id FROM rtms_rules WHERE rule_name = $1 AND cost_center_id IS NOT DISTINCT FROM $2',
        [rule_name, ccId]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, message: `Rule "${rule_name}" already exists for this cost center` });
      }
      const result = await query(`
        INSERT INTO rtms_rules (module, rule_name, system_constraint, audit_focus, max_value, min_value, unit, enabled, cost_center_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
      `, [module, rule_name, system_constraint || '', audit_focus || '', max_value || 0, min_value || 0, unit || '', enabled !== false, ccId]);
      return res.json({ success: true, rule: result.rows[0] });
    }

    // Bulk upsert
    if (!Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({ success: false, message: 'rules array or rule_name required' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      for (const rule of rules) {
        const ccId = rule.cost_center_id || cost_center_id || null;
        await client.query(`
          INSERT INTO rtms_rules (module, rule_name, system_constraint, audit_focus, max_value, min_value, unit, enabled, cost_center_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (rule_name, cost_center_id) DO UPDATE SET
            module = EXCLUDED.module,
            system_constraint = EXCLUDED.system_constraint,
            audit_focus = EXCLUDED.audit_focus,
            max_value = EXCLUDED.max_value,
            min_value = EXCLUDED.min_value,
            unit = EXCLUDED.unit,
            enabled = EXCLUDED.enabled,
            updated_at = NOW()
        `, [rule.module, rule.rule_name, rule.system_constraint || '', rule.audit_focus || '', rule.max_value || 0, rule.min_value || 0, rule.unit || '', rule.enabled !== false, ccId]);
      }

      await client.query('COMMIT');
      res.json({ success: true, count: rules.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[RTMS] Upsert rules error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/rtms/rules/:id - Update single rule
router.put('/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { module, rule_name, system_constraint, audit_focus, max_value, min_value, unit, enabled, cost_center_id } = req.body;

    const result = await query(`
      UPDATE rtms_rules SET
        module = COALESCE($1, module),
        rule_name = COALESCE($2, rule_name),
        system_constraint = COALESCE($3, system_constraint),
        audit_focus = COALESCE($4, audit_focus),
        max_value = COALESCE($5, max_value),
        min_value = COALESCE($6, min_value),
        unit = COALESCE($7, unit),
        enabled = COALESCE($8, enabled),
        cost_center_id = COALESCE($9, cost_center_id),
        updated_at = NOW()
      WHERE id = $10 RETURNING *
    `, [module, rule_name, system_constraint, audit_focus, max_value, min_value, unit, enabled, cost_center_id, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rule not found' });
    }
    res.json({ success: true, rule: result.rows[0] });
  } catch (err) {
    console.error('[RTMS] Update rule error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/rtms/rules/:id - Delete rule
router.delete('/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM rtms_rules WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rule not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[RTMS] Delete rule error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/rtms/engine-on - Log engine on event
router.post('/engine-on', async (req, res) => {
  try {
    const { device_id, fleet_number, registration_number } = req.body;
    if (!device_id) return res.status(400).json({ success: false, message: 'device_id required' });

    // Check if there's already an active session
    const existing = await query(
      'SELECT id FROM rtms_driving_sessions WHERE device_id = $1 AND engine_off_at IS NULL',
      [device_id]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, session_id: existing.rows[0].id, message: 'Session already active' });
    }

    const { findVehicleCostCenterId } = require('../services/costCenterLookup');
    const ccId = await findVehicleCostCenterId(fleet_number || device_id);

    const result = await query(`
      INSERT INTO rtms_driving_sessions (device_id, fleet_number, registration_number, engine_on_at, cost_center_id)
      VALUES ($1, $2, $3, NOW(), $4) RETURNING id
    `, [device_id, fleet_number || null, registration_number || null, ccId]);

    res.json({ success: true, session_id: result.rows[0].id });
  } catch (err) {
    console.error('[RTMS] Engine on error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/rtms/engine-off - Log engine off event
router.post('/engine-off', async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ success: false, message: 'device_id required' });

    const result = await query(`
      UPDATE rtms_driving_sessions 
      SET engine_off_at = NOW() 
      WHERE device_id = $1 AND engine_off_at IS NULL 
      RETURNING id, duration_minutes
    `, [device_id]);

    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'No active session found' });
    }

    res.json({ success: true, session_id: result.rows[0].id, duration: result.rows[0].duration_minutes });
  } catch (err) {
    console.error('[RTMS] Engine off error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/rtms/sessions/active - Get all active driving sessions
router.get('/sessions/active', async (req, res) => {
  try {
    const result = await query(`
      SELECT s.*, r.max_value as max_minutes
      FROM rtms_driving_sessions s
      LEFT JOIN rtms_rules r
        ON r.rule_name = 'Driver Hours' AND r.enabled = true
        AND (r.cost_center_id = s.cost_center_id OR (r.cost_center_id IS NULL AND s.cost_center_id IS NULL) OR (s.cost_center_id IS NOT NULL AND r.cost_center_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM rtms_rules r2
          WHERE r2.rule_name = r.rule_name AND r2.enabled = true AND r2.cost_center_id = s.cost_center_id
        )))
      WHERE s.engine_off_at IS NULL
      ORDER BY s.engine_on_at ASC
    `);
    res.json({ success: true, sessions: result.rows });
  } catch (err) {
    console.error('[RTMS] Get active sessions error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
