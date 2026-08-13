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

// Get all telematics events (for map plotting)
router.get('/events', async (req, res) => {
  try {
    const { deviceId, type, days = 30, limit = 500 } = req.query;

    let query = `SELECT * FROM telematics_events WHERE latitude IS NOT NULL AND longitude IS NOT NULL`;
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

module.exports = router;
