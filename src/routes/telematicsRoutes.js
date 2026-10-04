const express = require('express');
const db = require('../db');
const { processAlertDeduction } = require('../services/driverScoringService');
const { transformDbAlert } = require('../helpers/transform');
const { batchResolveDeviceCC, buildStrictAlertFilter } = require('../controllers/dbAlertController');

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
      'SELECT id, name, points, is_high_risk, is_no_go FROM geotab_zones WHERE is_deleted IS NOT TRUE ORDER BY name'
    );
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Zone CRUD (Stops UI) ──
// Writes go straight into geotab_zones — the same table the pollers use for
// vehicle-in-zone risk checks — so edits take effect live. locally_modified
// (set by the db layer) shields the row from the 5-min Geotab sync; is_deleted
// tombstones prevent resurrection.

function validateZonePayload(body) {
  const name = String((body && body.name) || '').trim();
  if (!name) return { error: 'name is required' };

  let points = body.points;
  if (typeof points === 'string') {
    try { points = JSON.parse(points); } catch { return { error: 'points must be valid JSON' }; }
  }
  if (!Array.isArray(points) || points.length < 3) {
    return { error: 'points must be an array of at least 3 vertices' };
  }
  const clean = [];
  for (const p of points) {
    const x = Number(p && p.x); // longitude
    const y = Number(p && p.y); // latitude
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'each point needs numeric x (lng) and y (lat)' };
    if (x < -180 || x > 180 || y < -90 || y > 90) return { error: 'point coordinates out of range' };
    clean.push({ x, y });
  }

  const type = String((body && body.type) || 'normal').toLowerCase();
  if (!['high_risk', 'no_go', 'normal'].includes(type)) return { error: "type must be one of 'high_risk', 'no_go', 'normal'" };

  return {
    name,
    points: clean,
    comment: body.comment ? String(body.comment).trim().slice(0, 1000) : null,
    isHighRisk: type === 'high_risk',
    isNoGo: type === 'no_go',
  };
}

async function zoneCachesRefresh() {
  // Lazy require: mirror the pollers' own pattern, avoids load-order coupling.
  const deviceStatusPoller = require('../services/deviceStatusPoller');
  const geotabPolling = require('../services/geotabPolling');
  deviceStatusPoller.invalidateZonesCache();
  await geotabPolling.refreshZoneCaches();
}

router.post('/zones', async (req, res) => {
  try {
    const payload = validateZonePayload(req.body || {});
    if (payload.error) return res.status(400).json({ success: false, message: payload.error });
    const id = `local_${require('crypto').randomUUID()}`;
    const zone = await db.createGeotabZone({ id, ...payload });
    if (!zone) return res.status(409).json({ success: false, message: 'zone id already exists' });
    await zoneCachesRefresh();
    res.status(201).json({ success: true, data: zone });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/zones/:id', async (req, res) => {
  try {
    const payload = validateZonePayload(req.body || {});
    if (payload.error) return res.status(400).json({ success: false, message: payload.error });
    const zone = await db.updateGeotabZone(req.params.id, payload);
    if (!zone) return res.status(404).json({ success: false, message: 'zone not found' });
    await zoneCachesRefresh();
    res.json({ success: true, data: zone });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/zones/:id', async (req, res) => {
  try {
    const zone = await db.softDeleteGeotabZone(req.params.id);
    if (!zone) return res.status(404).json({ success: false, message: 'zone not found' });
    await zoneCachesRefresh();
    res.json({ success: true, data: { id: zone.id, deleted: true } });
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
      `SELECT device_id, SUM(count) as alert_count,
              MAX(last_alert_ts) as latest_alert_ts,
              ARRAY_AGG(DISTINCT alarm_type) as alert_types
       FROM alert_groups
       WHERE resolved = FALSE AND false_alert = FALSE
       GROUP BY device_id`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// All unresolved alert groups for a specific device (used by resolve modal)
// Returns grouped alerts (same type grouped together with count)
// Matches video camera id AND Geotab sibling ids for the same fleet.
router.get('/vehicle-alerts/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { fleet } = req.query;

    let where = `WHERE ag.resolved = FALSE AND ag.false_alert = FALSE`;
    const params = [];
    let idx = 1;

    const idSet = new Set();
    if (deviceId && deviceId !== 'none') idSet.add(String(deviceId).trim());
    const fleetName = String(fleet || '').trim();

    // Resolve fleet from explicit query or from device_name / cost-center lookup
    let fleetKey = fleetName;
    if (!fleetKey && deviceId && deviceId !== 'none') {
      try {
        const named = await db.query(
          `SELECT device_name FROM alert_groups WHERE device_id = $1 ORDER BY last_alert_ts DESC NULLS LAST LIMIT 1`,
          [deviceId]
        );
        const deviceName = named.rows[0]?.device_name || '';
        const { resolveFleetNumber } = require('../services/costCenterLookup');
        fleetKey = await resolveFleetNumber({ vehicleRegistration: deviceName, deviceId }) || null;
        if (!fleetKey && deviceName) fleetKey = String(deviceName).split(' - ')[0].trim() || null;
        // Device id itself is often the fleet code (PD126, EX67) when device_name is empty.
        if (!fleetKey) {
          fleetKey = await resolveFleetNumber({ fleetNumber: deviceId }).catch(() => null) || null;
          if (!fleetKey && /^[A-Za-z]{2,}[\d-]*$/.test(String(deviceId).trim())) {
            fleetKey = String(deviceId).trim();
          }
        }
      } catch (_) { fleetKey = null; }
    }

    if (fleetKey) {
      try {
        const g = await db.query(
          `SELECT id FROM geotab_devices WHERE upper(trim(fleet_number)) = upper($1)`,
          [fleetKey]
        );
        g.rows.forEach((r) => r.id && idSet.add(String(r.id)));
      } catch (_) { /* optional */ }
      try {
        const vs = await db.query(
          `SELECT device_id FROM vehicle_status WHERE upper(trim(fleet_number)) = upper($1)`,
          [fleetKey]
        );
        vs.rows.forEach((r) => r.device_id && idSet.add(String(r.device_id)));
      } catch (_) { /* optional */ }
      try {
        const byName = await db.query(
          `SELECT DISTINCT device_id FROM alert_groups
           WHERE split_part(coalesce(device_name, ''), ' - ', 1) ILIKE $1
              OR split_part(coalesce(device_name, ''), ' - ', 2) ILIKE $1
           LIMIT 500`,
          [fleetKey]
        );
        byName.rows.forEach((r) => r.device_id && idSet.add(String(r.device_id)));
      } catch (_) { /* ignore */ }
    }

    const idList = [...idSet];
    if (idList.length === 0 && !fleetKey) {
      return res.json({ success: true, alerts: [], count: 0 });
    }

    const matchClauses = [];
    if (idList.length > 0) {
      params.push(idList);
      matchClauses.push(`ag.device_id = ANY($${idx}::text[])`);
      idx++;
    }
    if (fleetKey) {
      params.push(fleetKey);
      params.push(`%${fleetKey}%`);
      matchClauses.push(`split_part(coalesce(ag.device_name, ''), ' - ', 1) ILIKE $${idx}`);
      matchClauses.push(`split_part(coalesce(ag.device_name, ''), ' - ', 2) ILIKE $${idx}`);
      matchClauses.push(`ag.device_name ILIKE $${idx + 1}`);
      idx += 2;
    }
    where += ` AND (${matchClauses.join(' OR ')})`;

    const result = await db.query(
      `SELECT ag.*, COALESCE(a.lat, ag.lat) AS lat, COALESCE(a.lon, ag.lon) AS lon
       FROM alert_groups ag
       LEFT JOIN alerts a ON a.id = ag.last_alert_id
       ${where}
       ORDER BY ag.last_alert_ts DESC`,
      params
    );

    const groups = result.rows;
    let alerts = groups;
    try {
      const { deviceCC } = await batchResolveDeviceCC(groups);
      const { passes, severityFor } = await buildStrictAlertFilter(deviceCC);
      // Strict filter: same rules as the active-alerts list — only definitions
      // in the device's cost-center set (or active global for CC-less devices).
      const visible = groups.filter((g) => passes(g));
      alerts = visible.map((row) => {
        const t = transformDbAlert(row, severityFor(row));
        t.lat = row.lat;
        t.lon = row.lon;
        if (!t.alarm_text && row.alarm_text) t.alarm_text = row.alarm_text;
        return t;
      });
    } catch (transformError) {
      console.error('[vehicle-alerts] transform failed:', transformError.message);
    }

    res.json({ success: true, alerts, count: alerts.length, device_ids: idList, fleet: fleetKey || null });
  } catch (error) {
    console.error('[vehicle-alerts] Error:', error.message, error.stack);
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
         SELECT device_id, SUM(count) as alert_count,
                 MAX(last_alert_ts) as latest_alert_ts,
                 ARRAY_AGG(DISTINCT alarm_type) as alert_types
         FROM alert_groups
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
