const express = require('express');
const db = require('../db');

const router = express.Router();

// Get all telematics events for a vehicle
router.get('/vehicle/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { limit = 100, type, days = 30 } = req.query;

    let query = `SELECT * FROM telematics_events WHERE device_id = $1`;
    const params = [deviceId];
    let paramIdx = 2;

    if (type) {
      query += ` AND event_type = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }

    if (days) {
      query += ` AND event_time >= NOW() - INTERVAL '${parseInt(days)} days'`;
    }

    query += ` ORDER BY event_time DESC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get telematics events in time window
router.get('/events/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { from, to, limit = 500 } = req.query;

    let query = `SELECT * FROM telematics_events WHERE device_id = $1`;
    const params = [deviceId];
    let paramIdx = 2;

    if (from) {
      query += ` AND event_time >= $${paramIdx}`;
      params.push(from);
      paramIdx++;
    }
    if (to) {
      query += ` AND event_time <= $${paramIdx}`;
      params.push(to);
      paramIdx++;
    }

    query += ` ORDER BY event_time ASC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all telematics events
router.get('/events', async (req, res) => {
  try {
    const { deviceId, type, days = 30, limit = 500 } = req.query;

    let query = `SELECT * FROM telematics_events WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (deviceId) {
      query += ` AND device_id = $${paramIdx}`;
      params.push(deviceId);
      paramIdx++;
    }

    if (type) {
      query += ` AND event_type = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }

    if (days) {
      query += ` AND event_time >= NOW() - INTERVAL '${parseInt(days)} days'`;
    }

    query += ` ORDER BY event_time DESC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get event types for a vehicle
router.get('/vehicle/:deviceId/types', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const result = await db.query(
      `SELECT event_type, COUNT(*) as count, MAX(event_time) as latest
       FROM telematics_events
       WHERE device_id = $1
       GROUP BY event_type
       ORDER BY count DESC`,
      [deviceId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Store telematics events (batch insert)
router.post('/events', async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, message: 'Events array required' });
    }

    const inserted = [];
    for (const event of events) {
      const result = await db.query(
        `INSERT INTO telematics_events (device_id, vehicle_id, plate, event_type, event_code, severity, latitude, longitude, speed, address, driver_name, description, raw_data, event_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          event.device_id,
          event.vehicle_id || null,
          event.plate || null,
          event.event_type,
          event.event_code || null,
          event.severity || 'LOW',
          event.latitude || null,
          event.longitude || null,
          event.speed || null,
          event.address || null,
          event.driver_name || null,
          event.description || null,
          event.raw_data ? JSON.stringify(event.raw_data) : '{}',
          event.event_time || new Date(),
        ]
      );
      inserted.push(result.rows[0]);
    }

    res.json({ success: true, data: inserted, count: inserted.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Vehicle Status ──

router.get('/vehicle-status/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const status = await db.getVehicleStatus(deviceId);
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/vehicle-status-all', async (req, res) => {
  try {
    const statuses = await db.getAllVehicleStatus();
    res.json({ success: true, data: statuses, count: statuses.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Geotab Zones ──

router.get('/zones', async (req, res) => {
  try {
    const zones = await db.getGeotabZones();
    res.json({ success: true, data: zones, count: zones.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Zone Entries (breaches) ──

router.get('/zone-entries', async (req, res) => {
  try {
    const { deviceId, from, to } = req.query;
    const entries = await db.getZoneEntries(deviceId, from, to);
    res.json({ success: true, data: entries, count: entries.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/zone-entries-active', async (req, res) => {
  try {
    const entries = await db.getAllActiveZoneEntries();
    res.json({ success: true, data: entries, count: entries.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Log Records (GPS positions) ──

router.get('/log-records/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to query params required' });
    }
    const records = await db.getVehicleLogRecords(deviceId, from, to);
    res.json({ success: true, data: records, count: records.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
