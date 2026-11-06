const express = require('express');
const db = require('../db');

const router = express.Router();

// Admin-only maintenance endpoints.

function isAdmin(req) {
  const role = String(req.userRole || '').trim().toLowerCase();
  return role === 'admin' || role === 'administrator' || role === 'super admin';
}

// POST /admin/clear-alerts — clear OPEN alerts only (not resolved, not false).
// Keeps resolved and false alerts so the NCR register and closed-alert
// history are preserved. DELETE fires the row-level trigger so each removed
// group broadcasts ALERT_CLOSED (PURGED) via SSE — the frontend clears live.
// alert_media cascades from alerts. telematics_events is raw data, not touched.
router.post('/clear-alerts', async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    const before = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM alert_groups WHERE resolved = FALSE AND false_alert = FALSE) AS groups,
         (SELECT COUNT(*) FROM alerts WHERE resolved = FALSE AND false_alert = FALSE) AS alerts`
    );
    const counts = before.rows[0] || {};
    // Delete open member alerts first (alert_media cascades), then open groups.
    // Each group DELETE fires trg_alert_group_notify → pg_notify → SSE.
    await db.query(
      `DELETE FROM alerts WHERE resolved = FALSE AND false_alert = FALSE`
    );
    await db.query(
      `DELETE FROM alert_groups WHERE resolved = FALSE AND false_alert = FALSE`
    );
    // Clean up orphaned combo events (ON DELETE SET NULL left them behind).
    await db.query(
      `DELETE FROM alert_combo_events WHERE alert_id IS NULL AND alert_group_id IS NULL`
    );
    console.log(
      `[ADMIN] open alerts cleared by ${req.user?.email || 'unknown'}: ` +
      `${counts.groups} groups, ${counts.alerts} member alerts (resolved/false preserved)`
    );
    res.json({
      success: true,
      cleared: {
        alert_groups: Number(counts.groups || 0),
        alerts: Number(counts.alerts || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
