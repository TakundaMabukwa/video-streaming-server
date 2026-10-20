const express = require('express');
const db = require('../db');

const router = express.Router();

// Admin-only maintenance endpoints.

function isAdmin(req) {
  const role = String(req.userRole || '').trim().toLowerCase();
  return role === 'admin' || role === 'administrator' || role === 'super admin';
}

// POST /admin/clear-alerts — wipe the alert history so the board starts clean.
// Clears alerts, alert_groups, telematics_events (+ alert_media, which
// cascades from alerts). Vehicle registry, telemetry history and the driver
// scoring tables are NOT touched.
router.post('/clear-alerts', async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    const before = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM alert_groups) AS groups,
         (SELECT COUNT(*) FROM alerts) AS alerts,
         (SELECT COUNT(*) FROM telematics_events) AS events`
    );
    const counts = before.rows[0] || {};
    await db.query('BEGIN');
    try {
      // alert_media cascades from alerts, but clear it explicitly so the
      // order never depends on FK timing.
      await db.query('DELETE FROM alert_media');
      await db.query('DELETE FROM alerts');
      await db.query('DELETE FROM alert_groups');
      await db.query('DELETE FROM telematics_events');
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
    console.log(
      `[ADMIN] alerts cleared by ${req.user?.email || 'unknown'}: ` +
      `${counts.groups} groups, ${counts.alerts} alerts, ${counts.events} events`
    );
    res.json({
      success: true,
      cleared: {
        alert_groups: Number(counts.groups || 0),
        alerts: Number(counts.alerts || 0),
        telematics_events: Number(counts.events || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
