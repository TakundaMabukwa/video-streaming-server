const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { createSolfloJob, getConfig } = require('../services/solfloJobs');

function formatSAST(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const parts = new Intl.DateTimeFormat('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
    return `${parts} SAST`;
  } catch {
    return String(iso || '');
  }
}

// POST /api/repair-requests - Create a repair request + forward to Solflo job cards
router.post('/', async (req, res) => {
  try {
    const {
      alert_id, fleet_number, registration, device_id, cost_center_id, notes, created_by,
      contact_name, contact_phone, contact_email, available_at = null, issue_description, priority, account_code,
    } = req.body || {};

    const fleet = String(fleet_number || '').trim();
    if (!fleet) return res.status(400).json({ success: false, message: 'fleet_number is required' });
    if (!String(contact_name || '').trim()) return res.status(400).json({ success: false, message: 'contact_name is required' });
    if (!String(contact_phone || '').trim()) return res.status(400).json({ success: false, message: 'contact_phone is required' });
    if (!String(contact_email || '').trim()) return res.status(400).json({ success: false, message: 'contact_email is required' });
    if (!String(issue_description || '').trim()) return res.status(400).json({ success: false, message: 'issue_description is required' });

    const prio = ['low', 'medium', 'high'].includes(String(priority || '').toLowerCase())
      ? String(priority).toLowerCase()
      : 'medium';
    const { defaultAccountCode } = getConfig();
    const acct = String(account_code || defaultAccountCode || 'SRS-0001').trim();

    const jobDescription = [
      String(issue_description).trim(),
      `Alert: ${(req.body.alarm_type || req.body.alarmType || '').toString().trim() || 'N/A'} (${fleet} / ${String(registration || '').trim() || 'N/A'})`,
      `Contact: ${String(contact_name).trim()} - ${String(contact_phone).trim()} - ${String(contact_email).trim()}`,
      available_at ? `Vehicle available: ${formatSAST(available_at)}` : null,
      `Requested by: ${String(created_by || 'SRS user').trim()} via SRS alerts`,
    ].filter(Boolean).join('\n');

    let external = null;
    let externalError = null;
    try {
      external = await createSolfloJob({
        vehicle_reg: fleet,
        job_description: jobDescription,
        priority: prio,
        account_code: acct,
      });
    } catch (err) {
      externalError = err;
      console.error('[RepairRequests] Solflo create failed:', err.message);
    }

    const externalJob = external?.job || null;
    const result = await query(
      `INSERT INTO repair_requests (alert_id, fleet_number, registration, device_id, cost_center_id, notes, created_by,
        contact_name, contact_phone, contact_email, available_at, issue_description, job_description, priority, account_code,
        external_job_number, external_job_type, external_status, external_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) RETURNING *`,
      [
        alert_id || null, fleet, registration || null, device_id || null, cost_center_id || null,
        notes || null, created_by || null,
        String(contact_name).trim(), String(contact_phone).trim(), String(contact_email).trim(),
        available_at, String(issue_description).trim(), jobDescription, prio, acct,
        externalJob?.job_number || null, external?.job_type || null,
        external ? 'created' : 'failed',
        JSON.stringify(external || { error: externalError?.message || 'unknown' }),
      ]
    );

    if (!external) {
      return res.status(502).json({
        success: false,
        message: 'Failed to log job. Contact monique@soltrack.co.za',
        repair: result.rows[0],
        error: externalError?.message || 'Solflo create failed',
      });
    }
    res.json({ success: true, repair: result.rows[0], job: externalJob, job_type: external?.job_type || null });
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
