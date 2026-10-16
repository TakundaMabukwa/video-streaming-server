const express = require('express');
const db = require('../db');

const router = express.Router();

// POST /ncr/outbox — enqueue finished escalation emails; returns in ms.
// Delivery + retry happens in the ncrEmailSweeper, never in the request.
router.post('/outbox', async (req, res) => {
  try {
    const { to, subject, html, ncr_no, group_name } = req.body || {};
    const addrs = Array.isArray(to) ? to.map((a) => String(a || '').trim()).filter(Boolean) : [];
    if (addrs.length === 0 || !subject || !html) {
      return res.status(400).json({ success: false, message: 'to[], subject and html are required' });
    }
    const r = await db.query(
      `INSERT INTO ncr_email_outbox (to_addrs, subject, html, ncr_no, group_name)
       VALUES ($1::text[], $2, $3, $4, $5) RETURNING id`,
      [addrs, String(subject), String(html), ncr_no ? String(ncr_no) : null, group_name ? String(group_name) : null]
    );
    res.json({ success: true, queued: true, id: r.rows[0].id, recipients: addrs.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/outbox-status — recent delivery state for ops visibility.
router.get('/outbox-status', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM ncr_email_outbox
       WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status`
    );
    res.json({ success: true, states: r.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
