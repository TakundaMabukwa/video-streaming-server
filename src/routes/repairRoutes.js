const express = require('express');
const router = express.Router();
const { query } = require('../db');

// POST /api/repair-requests - Create a repair request
router.post('/', async (req, res) => {
  try {
    const { alert_id, fleet_number, registration, device_id, cost_center_id, notes, created_by } = req.body || {};
    const result = await query(
      `INSERT INTO repair_requests (alert_id, fleet_number, registration, device_id, cost_center_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [alert_id || null, fleet_number || null, registration || null, device_id || null, cost_center_id || null, notes || null, created_by || null]
    );
    res.json({ success: true, repair: result.rows[0] });
  } catch (err) {
    console.error('[RepairRequests] Create error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/repair-requests - List repair requests
router.get('/', async (req, res) => {
  try {
    const { fleet_number, status, limit = 100, offset = 0 } = req.query;
    let where = [];
    let params = [];
    if (fleet_number) { params.push(fleet_number); where.push(`fleet_number = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(parseInt(limit));
    params.push(parseInt(offset));
    const result = await query(
      `SELECT * FROM repair_requests ${whereClause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM repair_requests ${whereClause}`,
      params.slice(0, -2)
    );
    res.json({ success: true, repairs: result.rows, total: countResult.rows[0]?.total || 0 });
  } catch (err) {
    console.error('[RepairRequests] List error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/repair-requests/:id - Update status
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body || {};
    const sets = [];
    const params = [];
    if (status) { params.push(status); sets.push(`status = $${params.length}`); }
    if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    const result = await query(
      `UPDATE repair_requests SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, repair: result.rows[0] });
  } catch (err) {
    console.error('[RepairRequests] Update error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
