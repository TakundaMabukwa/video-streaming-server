const express = require('express');
const db = require('../db');
const { processAlertDeduction } = require('../services/driverScoringService');

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

      // Process automatic deduction (NCR = no path)
      if (event.plate) {
        try {
          // Look up fleet_number from vehiclesc using plate
          const fleetResult = await db.query(
            'SELECT fleet_number FROM vehiclesc WHERE registration_number = $1 OR plate = $1 OR license_plate = $1 LIMIT 1',
            [event.plate]
          );
          if (fleetResult.rows.length > 0 && fleetResult.rows[0].fleet_number) {
            await processAlertDeduction(fleetResult.rows[0].fleet_number, event.event_type);
          }
        } catch (deductErr) {
          console.error('[Telematics] Deduction error:', deductErr.message);
        }
      }
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

// Lightweight zones (no raw_data) for fast map rendering
router.get('/zones-lite', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, points, is_high_risk, is_no_go FROM geotab_zones ORDER BY name'
    );
    res.json({ success: true, data: result.rows, count: result.rows.length });
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

// ── Priority Zones (high-risk + no-go first) ──

router.get('/zones-priority', async (req, res) => {
  try {
    const allZones = await db.getGeotabZones();
    const priority = allZones.filter(z => z.is_high_risk || z.is_no_go);
    const rest = allZones.filter(z => !z.is_high_risk && !z.is_no_go);
    res.json({ success: true, priority, rest, total: allZones.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Today's Events for a vehicle (from midnight) ──

router.get('/events-today/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const result = await db.query(
      `SELECT * FROM telematics_events
       WHERE device_id = $1 AND event_time >= (NOW() AT TIME ZONE 'UTC')::date
       ORDER BY event_time ASC`,
      [deviceId]
    );
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Vehicle alert counts (active unresolved alerts per device) ──

router.get('/vehicle-alerts', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT device_id, COUNT(*) as alert_count,
              MAX(alarm_ts) as latest_alert_ts,
              ARRAY_AGG(DISTINCT alarm_type) as alert_types
       FROM alerts
       WHERE resolved = FALSE AND false_alert = FALSE
       GROUP BY device_id`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// All unresolved alerts for a specific device (used by resolve modal)
// Queries alerts table directly — both video and telematics alerts live here
router.get('/vehicle-alerts/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { fleet } = req.query;

    let where = `WHERE resolved = FALSE AND false_alert = FALSE`;
    const params = [];
    let idx = 1;

    if (deviceId && deviceId !== 'none') {
      where += ` AND (device_id = $${idx} OR device_name ILIKE $${idx + 1})`;
      params.push(deviceId, `%${deviceId}%`);
      idx += 2;
    }
    if (fleet) {
      where += ` AND device_name ILIKE $${idx}`;
      params.push(`%${fleet}%`);
      idx++;
    }

    if (params.length === 0) {
      return res.json({ success: true, alerts: [], count: 0 });
    }

    const result = await db.query(
      `SELECT * FROM alerts ${where} ORDER BY alarm_ts DESC`,
      params
    );

    res.json({ success: true, alerts: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Vehicle status with enriched alert data ──

router.get('/vehicle-status-all-enriched', async (req, res) => {
  try {
    const statuses = await db.query(
      `SELECT vs.*,
              COALESCE(a.alert_count, 0)::int as alert_count,
              a.latest_alert_ts,
              a.alert_types
       FROM vehicle_status vs
       LEFT JOIN (
         SELECT device_id, COUNT(*) as alert_count,
                MAX(alarm_ts) as latest_alert_ts,
                ARRAY_AGG(DISTINCT alarm_type) as alert_types
         FROM alerts
         WHERE resolved = FALSE AND false_alert = FALSE
         GROUP BY device_id
       ) a ON vs.device_id = a.device_id
       ORDER BY vs.fleet_number`
    );
    res.json({ success: true, data: statuses.rows, count: statuses.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
