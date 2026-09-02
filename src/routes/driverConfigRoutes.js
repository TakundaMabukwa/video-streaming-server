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

// Get criteria for a specific cost center (group + CC-specific + global)
router.get('/criteria/for-cc/:costCenterId', async (req, res) => {
  try {
    const { costCenterId } = req.params;
    const ccId = Number(costCenterId);
    const result = await db.query(
      `SELECT * FROM driver_config_criteria
       WHERE is_active = true
       AND (
         config_group_id IN (SELECT group_id FROM config_group_members WHERE cost_center_id = $1)
         OR cost_center_id = $1
         OR (config_group_id IS NULL AND cost_center_id IS NULL)
       )
       ORDER BY
         CASE WHEN config_group_id IS NOT NULL THEN 1
              WHEN cost_center_id IS NOT NULL THEN 2
              ELSE 3 END,
         name ASC`,
      [ccId]
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
    const { name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id, config_group_id } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    const result = await db.query(
      `INSERT INTO driver_config_criteria (name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id, config_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
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
        config_group_id || null,
      ]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Criterion with this name already exists for this scope' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update criterion
router.put('/criteria/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, is_active, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id, config_group_id } = req.body;

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
           config_group_id = $14,
           updated_at = NOW()
       WHERE id = $15 RETURNING *`,
      [name, selected_weighting, actual_weighting, risk_tiers, no_incidents, statuses, is_active, nrc_deduction, incidents_threshold, deduction_per_alert, deduction_with_ncr, ncr_threshold, cost_center_id || null, config_group_id || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Criterion not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Criterion with this name already exists for this scope' });
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

// ── Config Groups ──

// List all config groups with member count
router.get('/config-groups', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.id, g.name, g.created_at,
              COALESCE(cm.members, '[]'::jsonb) AS members,
              COALESCE(cm.member_count, 0) AS member_count
       FROM config_groups g
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(m.cost_center_id) AS members, COUNT(*) AS member_count
         FROM config_group_members m WHERE m.group_id = g.id
       ) cm ON true
       ORDER BY g.name ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create config group with members
router.post('/config-groups', async (req, res) => {
  const client = await db.getClient();
  try {
    const { name, cost_center_ids = [] } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    await client.query('BEGIN');

    const groupResult = await client.query(
      'INSERT INTO config_groups (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    const group = groupResult.rows[0];

    if (cost_center_ids.length > 0) {
      const placeholders = cost_center_ids.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO config_group_members (group_id, cost_center_id) VALUES ${placeholders}`,
        [group.id, ...cost_center_ids]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { ...group, members: cost_center_ids } });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Group with this name already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// Update config group (name + members)
router.put('/config-groups/:id', async (req, res) => {
  const client = await db.getClient();
  try {
    const { id } = req.params;
    const { name, cost_center_ids } = req.body;

    await client.query('BEGIN');

    if (name !== undefined) {
      await client.query('UPDATE config_groups SET name = $1 WHERE id = $2', [name.trim(), id]);
    }

    if (Array.isArray(cost_center_ids)) {
      await client.query('DELETE FROM config_group_members WHERE group_id = $1', [id]);
      if (cost_center_ids.length > 0) {
        const placeholders = cost_center_ids.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO config_group_members (group_id, cost_center_id) VALUES ${placeholders}`,
          [Number(id), ...cost_center_ids]
        );
      }
    }

    await client.query('COMMIT');

    const groupResult = await client.query(
      `SELECT g.id, g.name, g.created_at,
              COALESCE((SELECT jsonb_agg(m.cost_center_id) FROM config_group_members m WHERE m.group_id = g.id), '[]'::jsonb) AS members
       FROM config_groups g WHERE g.id = $1`,
      [id]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    res.json({ success: true, data: groupResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Group name already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// Delete config group
router.delete('/config-groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM config_groups WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get criteria for a specific config group
router.get('/config-groups/:id/criteria', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM driver_config_criteria WHERE config_group_id = $1 ORDER BY name ASC',
      [Number(id)]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
