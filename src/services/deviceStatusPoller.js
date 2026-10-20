const https = require('https');
const db = require('../db');
const turf = require('@turf/turf');
const { findVehicleCostCenterId } = require('./costCenterLookup');
const { isAlertActiveForCC } = require('../db/alert_definitions');
const { isRegisteredVehicle } = require('./fleetRegistryGuard');
const { escalateSeverity } = require('../helpers/transform');
const {
  FATIGUE_3H_CODE,
  FATIGUE_6H_CODE,
  FATIGUE_9H_CODE,
  DURATION_8H_CODE,
  DURATION_12H_CODE,
  DURATION_15H_CODE,
  SPEED_85_CODE,
  SPEED_90_CODE,
  ZONE_ENTRY_CODE,
  NOGO_ENTRY_CODE,
  NO_STOP_ENTRY_CODE,
  ZONE_APPROACHING_CODE,
  ZONE_STOP_IMMEDIATE_CODE,
  ZONE_STOP_1MIN_HIGH_CODE,
  ZONE_STOP_1MIN_NO_CODE,
} = require('../helpers/pollerOwnedAlerts');

const GEOTAB_URL = 'https://my.geotab.com/apiv1';
const POLL_INTERVAL_MS = 15000;

// Speed-cutoff(s) for "stopped" zone logic (km/h). High-risk zones flag a stop
// immediately at the tight threshold; No-Stopping zones require speed < 10.
const STOP_SPEED = 5;
const STOP_SPEED_NO_STOPPING = 10;
const ZONES_CACHE_TTL = 5 * 60 * 1000;
const META_CACHE_TTL = 60 * 1000;

// Freshness gate: a vehicle only counts as live when Geotab reports it as
// currently communicating AND its own event time (dateTime) is recent. Anything
// older than this is last-known data and must not drive alerts.
const DATA_FRESH_MS = 5 * 60 * 1000;
// Speed episode re-arm dwell: after a speed alert fires, the vehicle must stay
// below the threshold for ~30s (≈2 polls) before the alert can fire again.
const SPEED_REARM_DWELL_MS = 30 * 1000;

// Fatigue thresholds (minutes) -> alert_definitions.signal_code.
// Definition names are resolved at runtime via isAlertActiveForCC — nothing
// here is hardcoded by name. Sorted ascending so each threshold fires once.
const FATIGUE_THRESHOLDS = [
  { minutes: 180, signalCode: FATIGUE_3H_CODE }, // Driver Fatigue 3h
  { minutes: 360, signalCode: FATIGUE_6H_CODE }, // Driver Fatigue 6h
  { minutes: 480, signalCode: DURATION_8H_CODE }, // 8 Hour Duration Check
  { minutes: 540, signalCode: FATIGUE_9H_CODE }, // Driver fatigue 9h
  { minutes: 720, signalCode: DURATION_12H_CODE }, // 12 Hour Duration Check
  { minutes: 900, signalCode: DURATION_15H_CODE }, // 15 Hour Duration Check
];

// ── Module state ──
let pollTimer = null;
let wsBroadcast = null;
let inFlight = false;
let lastTrailPruneAt = 0;

let cachedCredentials = null;
let credentialsExpiry = null;

let zonesState = { data: null, ts: 0 };
// Called by the Stops CRUD routes: drop the 5-min zones cache so stop alerts
// use the edited geometry on the next poll cycle, not up to 5 minutes later.
function invalidateZonesCache() { zonesState = { data: null, ts: 0 }; }
let fleetSet = null;
let fleetTs = 0;
let geotabMap = null;
let geotabMapTs = 0;

// ── Geotab HTTP helpers (self-contained for testability) ──

function geotabFetch(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(GEOTAB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Geotab response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Geotab request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

async function geotabAuthenticate() {
  if (cachedCredentials && credentialsExpiry && Date.now() < credentialsExpiry) {
    return cachedCredentials;
  }
  const database = process.env.GEOTAB_DATABASE;
  const userName = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !userName || !password) throw new Error('Geotab credentials not configured');

  const response = await geotabFetch({ method: 'Authenticate', params: { database, userName, password } });
  if (response.error) throw new Error(response.error.message || 'Geotab authentication failed');
  const result = response.result || {};
  cachedCredentials = {
    database: result.credentials?.database || database,
    sessionId: result.credentials?.sessionId,
    userName: result.credentials?.userName || userName,
  };
  credentialsExpiry = Date.now() + (4 * 60 * 60 * 1000);
  return cachedCredentials;
}

// ── Duration/Timespan parsing ──

// Parse a .NET TimeSpan ("HH:MM:SS", "d.hh:mm:ss", "-...", fractional seconds)
// or a plain millisecond number into milliseconds.
function parseGeotabDurationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  let s = value.trim();
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  let days = 0;
  const dot = s.indexOf('.');
  if (dot >= 0) {
    days = parseInt(s.slice(0, dot), 10) || 0;
    s = s.slice(dot + 1);
  }
  const parts = s.split(':').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts.slice(-3);
  const ms = ((days * 24 + h) * 3600 + m * 60 + sec) * 1000;
  return negative ? -ms : ms;
}

// ── Cache loaders ──

async function getZones() {
  if (zonesState.data && Date.now() - zonesState.ts < ZONES_CACHE_TTL) return zonesState.data;
  const rows = await db.getHighRiskZones();
  const built = [];
  for (const z of rows) {
    let points = z.points;
    if (typeof points === 'string') {
      try { points = JSON.parse(points); } catch { continue; }
    }
    if (!Array.isArray(points) || points.length < 3) continue;
    const ring = points.map((p) => [Number(p.x), Number(p.y)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (ring.length < 3) continue;
    // Close ring if needed — turf.polygon requires closed ring (first == last)
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
      console.log(`[ZONE] auto-closed ring for zone ${z.name} (${z.id})`);
    }
    try {
      const poly = turf.cleanCoords(turf.polygon([ring]));
      built.push({ id: z.id, name: z.name, is_high_risk: !!z.is_high_risk, is_no_go: !!z.is_no_go, is_no_stopping: !!z.is_no_stopping, polygon: poly });
    } catch (err) {
      console.error(`[ZONE] invalid polygon for ${z.name} (${z.id}): ${err.message}`);
      continue;
    }
  }
  zonesState = { data: built, ts: Date.now() };
  return built;
}

async function getFleetSet() {
  if (fleetSet && Date.now() - fleetTs < META_CACHE_TTL) return fleetSet;
  const result = await db.query('SELECT fleet_number, registration_number FROM fleet_vehicles');
  const set = new Set();
  for (const row of result.rows) {
    if (row.fleet_number) set.add(String(row.fleet_number).trim().toUpperCase());
    if (row.registration_number) set.add(String(row.registration_number).trim().toUpperCase());
  }
  fleetSet = set;
  fleetTs = Date.now();
  return set;
}

async function getGeotabMap() {
  if (geotabMap && Date.now() - geotabMapTs < META_CACHE_TTL) return geotabMap;
  const result = await db.query(
    `SELECT gd.id, gd.name, gd.fleet_number, gd.license_plate, fv.mettax_device_id
     FROM geotab_devices gd
     LEFT JOIN fleet_vehicles fv ON fv.fleet_number = gd.fleet_number`
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.id, { 
      name: row.name, 
      fleetNumber: row.fleet_number, 
      licensePlate: row.license_plate,
      mettaxDeviceId: row.mettax_device_id
    });
  }
  geotabMap = map;
  geotabMapTs = Date.now();
  return map;
}

function isRegisteredToken(fleetNumber, licensePlate, fleetSet) {
  return !!(
    (fleetNumber && fleetSet.has(String(fleetNumber).trim().toUpperCase())) ||
    (licensePlate && fleetSet.has(String(licensePlate).trim().toUpperCase()))
  );
}

function findCurrentZone(zones, lat, lon) {
  for (const z of zones) {
    try {
      if (turf.booleanPointInPolygon(turf.point([lon, lat]), z.polygon)) {
        return { zone_id: z.id, zone_name: z.name, is_high_risk: z.is_high_risk, is_no_go: z.is_no_go };
      }
    } catch { /* skip bad polygon */ }
  }
  return null;
}

// ── Alert emission ──

// Create a device-status alert GROUP. Dedup rule (upsertAlertGroup):
// if the same vehicle already has an ACTIVE (unresolved) group for the same
// alarm_type, its counter is bumped — no duplicate insert. Otherwise a new
// group is created. Definition must be active for the vehicle's cost center
// (isAlertActiveForCC); a vehicle with no cost center still gets the alert as
// long as it exists in fleet_vehicles.
async function emitDeviceStatusAlert({ deviceId, fleetNumber, licensePlate, signalCode, alarmText, lat, lon, speed, ts, extra = {} }) {
  try {
    // Vehicle override: this vehicle must not raise this alert (checked
    // before anything is written — no group, no event row, no alert).
    const overrides = require('./vehicleAlertOverrides');
    if (overrides.isSuppressedSync({ fleetNumber, registration: licensePlate, signalCode })) {
      logDropOnce(`ovr:${signalCode}:${fleetNumber || deviceId}`, `[DEVSTATUS] suppressed ${signalCode} for ${fleetNumber || deviceId}: vehicle alert override`);
      return null;
    }
    const ccId = await findVehicleCostCenterId(fleetNumber || deviceId).catch(() => null);
    const def = await isAlertActiveForCC(signalCode, ccId).catch(() => null);
    if (!def) {
      logDropOnce(`def:${signalCode}:${ccId}`, `[DEVSTATUS] dropped ${signalCode} for ${fleetNumber || deviceId}: no active definition for cost centre ${ccId}`);
      return null;
    }

    const deviceName = fleetNumber
      ? `${fleetNumber}${licensePlate ? ' - ' + licensePlate : ''}`
      : (licensePlate || deviceId);

    if (!(await isRegisteredVehicle({ deviceId, deviceName }))) {
      logDropOnce(`reg:${deviceId}`, `[DEVSTATUS] dropped alerts for ${deviceName}: not in fleet_vehicles (registry guard)`);
      return null;
    }

    const alertId = `dst-${deviceId}-${signalCode}-${Date.now()}`;
    const alarmTs = ts || new Date().toISOString();

    // Speeding: the Geotab feed may already have recorded this spike (tel-*)
    // within 60s. Skip the poller copy so one spike is not counted twice.
    if (signalCode === SPEED_85_CODE || signalCode === SPEED_90_CODE) {
      const feedDup = await db.query(
        `SELECT 1 FROM alert_groups
         WHERE device_id = $1 AND alarm_type = $2 AND source_type = 'telematics'
           AND last_alert_id LIKE 'tel-%'
           AND ABS(EXTRACT(EPOCH FROM (last_alert_ts - $3::timestamptz))) <= 60
         LIMIT 1`,
        [deviceId, def.name, alarmTs]
      ).catch(() => ({ rows: [] }));
      if (feedDup.rows.length > 0) return null;
    }

    const groupRow = await db.upsertAlertGroup({
      deviceId,
      deviceName,
      alarmType: def.name,
      alarmText: alarmText || def.name,
      alertId,
      alarmTs,
      lat: lat ?? null,
      lon: lon ?? null,
      speed: speed ?? null,
      sourceType: 'telematics',
      severity: String(def.severity || 'MEDIUM').toLowerCase(),
      fleetNumber: fleetNumber || null,
      registration: licensePlate || null,
    });
    if (!groupRow) return null;

    // Archive per-event source row for history (alert_groups is the store).
    await db.query(
      `INSERT INTO telematics_events (device_id, vehicle_id, license_plate, fleet_number, plate,
        event_type, event_code, severity, latitude, longitude, speed, description, zone_name, raw_data, event_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        deviceId, deviceId, licensePlate || null, fleetNumber || null, licensePlate || null,
        def.name, signalCode, String(def.severity || 'MEDIUM').toUpperCase(),
        lat ?? null, lon ?? null, speed ?? null,
        alarmText || def.name, extra.zoneName || null,
        JSON.stringify({ signalCode, source: 'deviceStatus', ...extra }),
        alarmTs,
      ]
    ).catch(() => {});

    if (wsBroadcast) {
      try {
        const groupCount = Number(groupRow.count || 1) || 1;
        const baseSeverity = String(def.severity || 'medium').toLowerCase();
        const escalatedSeverity = escalateSeverity(baseSeverity, groupCount);
        const groupId = String(groupRow.id);
        wsBroadcast('new-alert', {
          alert: {
            id: groupId,
            alert_id: groupId,
            last_alert_id: alertId,
            alarmId: alertId,
            alarm_id: alertId,
            device_id: deviceId,
            deviceId,
            vehicleId: deviceId,
            device_name: deviceName,
            deviceName,
            alert_type: def.name,
            alarm_type: def.name,
            type: def.name,
            title: def.name,
            alarmText: alarmText || def.name,
            timestamp: new Date(alarmTs).toISOString(),
            alarmTs: new Date(alarmTs).toISOString(),
            last_occurrence: new Date(alarmTs).toISOString(),
            source_type: 'telematics',
            severity: escalatedSeverity,
            priority: escalatedSeverity,
            base_severity: baseSeverity,
            escalated: escalatedSeverity !== baseSeverity,
            status: 'new',
            resolved: false,
            count: groupCount,
            group_key: groupRow.group_key || `${deviceId}:${def.name}`.toLowerCase(),
            lat: lat ?? null,
            lon: lon ?? null,
          },
        });
      } catch (_) { /* never block alert emission on WS */ }
    }
    console.log(`[DEVSTATUS] alert created group=${groupRow.id} (${def.name}) for ${fleetNumber || deviceId}`);
    return groupRow;
  } catch (error) {
    console.error('[DEVSTATUS] alert emit failed:', error.message);
    return null;
  }
}

// ── Zone processing (per device, per poll) ──

async function processZoneForDevice(deviceId, fleetNumber, licensePlate, lat, lon, speed, dateTime, zones, entryMap, stopMap, prevLat, prevLon) {
  const nowTs = dateTime || new Date().toISOString();
  const currentZoneIds = [];
  const insideZones = [];
  const wasInside = entryMap.get(deviceId) || new Set();
  
  // Line-intersect entry detection: check if the vehicle's path (prev->current) 
  // crosses a zone boundary. This catches entries even when both points are outside.
  const hasPrevPos = prevLat != null && prevLon != null;
  const pathLine = hasPrevPos ? turf.lineString([[prevLon, prevLat], [lon, lat]]) : null;

  for (const z of zones) {
    let isInside = false;
    let crossedBoundary = false;
    try {
      // Point-in-polygon for current position
      isInside = turf.booleanPointInPolygon(turf.point([lon, lat]), z.polygon);
      // Line-intersect: if we have a previous position, check if path crossed boundary
      if (pathLine) {
        const intersects = turf.lineIntersect(pathLine, z.polygon);
        crossedBoundary = intersects.features.length > 0;
      }
    } catch { continue; }
    
    // Vehicle is inside if current point is inside, OR if path crossed boundary
    // (crossed boundary + not already inside = entry event)
    if (isInside) {
      currentZoneIds.push(z.id);
      insideZones.push(z);
    } else if (crossedBoundary && !wasInside.has(z.id)) {
      // Path crossed zone boundary but current point is outside (or on edge)
      // This indicates a crossing - treat as entry if we weren't already inside
      currentZoneIds.push(z.id);
      insideZones.push(z);
      console.log(`[ZONE] boundary crossing detected for ${fleetNumber || deviceId} -> ${z.name} (crossed, current outside)`);
    }
  }

  // ── Predictive Detection: bearing + 45s look-ahead ───────────────────
  // Check zones the vehicle is approaching (will enter within 45s at current speed/bearing)
  if (hasPrevPos) {
    const prevPoint = turf.point([prevLon, prevLat]);
    const currentPoint = turf.point([lon, lat]);
    
    // 1. Calculate bearing (-180 to 180, 0 = North)
    let bearing = 0;
    try {
      bearing = turf.bearing(prevPoint, currentPoint);
    } catch { bearing = 0; }
    
    // 2. Project forward (45 seconds at current speed, min 1 km/h)
    const speedKms = Math.max(Number(speed) || 0, 1) / 3600; // km/s
    const lookAheadSeconds = 45;
    const distanceKm = speedKms * lookAheadSeconds;
    
    // 3. Predicted point
    let predictedPoint = currentPoint;
    try {
      predictedPoint = turf.destination(currentPoint, distanceKm, bearing, { units: 'kilometers' });
    } catch { /* fallback to current point */ }
    
    // 4. Trajectory vector
    const trajectoryVector = turf.lineString([currentPoint.geometry.coordinates, predictedPoint.geometry.coordinates]);
    
    // 5. Check zones not currently inside and not already entered
    for (const z of zones) {
      if (insideZones.some(iz => iz.id === z.id)) continue; // Already inside
      if (wasInside.has(z.id)) continue; // Was inside, exit handled separately
      // Approaching alerts are high-risk-only: no-go / no-stopping zones never
      // emit here (their entries + stops still alert via the entry/stop paths).
      if (!z.is_high_risk) continue;

      try {
        const intersections = turf.lineIntersect(trajectoryVector, z.polygon);
        if (intersections.features.length > 0) {
          // Vehicle will enter zone within lookAheadSeconds
          const distanceToEntry = turf.distance(currentPoint, intersections.features[0], { units: 'kilometers' });
          const etaSeconds = Number(speed) > 0 ? (distanceToEntry / (Number(speed) / 3600)) : Infinity;
          
          // Emit "Approaching Zone" alert
          await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, 
            signalCode: ZONE_APPROACHING_CODE,
            alarmText: `Approaching ${z.is_no_go ? 'No-Go' : z.is_high_risk ? 'High Risk' : 'No Stopping'} Zone: ${z.name} (ETA ~${Math.round(etaSeconds)}s)`,
            lat, lon, speed, ts: nowTs,
            extra: { 
              zoneName: z.name, 
              zoneType: z.is_no_go ? 'no_go' : z.is_no_stopping ? 'no_stopping' : 'high_risk',
              etaSeconds: Math.round(etaSeconds),
              distanceMeters: Math.round(distanceToEntry * 1000),
              bearing: bearing.toFixed(1)
            },
          });
          
          console.log(`[ZONE-PREDICT] ${fleetNumber || deviceId} approaching ${z.name} (bearing: ${bearing.toFixed(1)}°, ETA ~${Math.round(etaSeconds)}s)`);
        }
      } catch (e) {
        // Ignore prediction errors per zone
      }
    }
  }

  // Exits FIRST and never gated by "inside anything": any open entry whose zone
  // no longer contains this fix is closed, including when the vehicle is outside
  // every watched zone. (The old early return skipped this, leaving entries open.)
  for (const zoneId of wasInside) {
    if (currentZoneIds.includes(zoneId)) continue;
    try {
      await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = $2
         WHERE device_id = $1 AND zone_id = $3 AND is_active = TRUE`,
        [deviceId, nowTs, zoneId]
      );
      wasInside.delete(zoneId);
    } catch (err) {
      console.error(`[ZONE] exit close failed device=${deviceId} zone=${zoneId}: ${err.message}`);
    }
  }

  // New entries → recorded for every watched zone. An entry is only ever
  // blocked by an entry that is still open for the SAME zone, never by other
  // zones or by recent alerts.
  for (const z of insideZones) {
    if (wasInside.has(z.id)) continue;
    const riskLevel = z.is_no_go ? 'CRITICAL' : z.is_high_risk ? 'HIGH' : 'MEDIUM';
    const entry = await db.insertZoneEntry({
      deviceId,
      fleetNumber,
      licensePlate,
      zoneId: z.id,
      zoneName: z.name,
      riskLevel,
      latitude: lat,
      longitude: lon,
      speed: speed ?? null,
      entryTime: nowTs,
    });
    if (entry && (z.is_high_risk || z.is_no_go || z.is_no_stopping)) {
      // Determine zone type with priority: no_go > no_stopping > high_risk
      const zoneType = z.is_no_go ? 'no_go' : z.is_no_stopping ? 'no_stopping' : 'high_risk';
      const zoneConfig = {
        no_go: { code: NOGO_ENTRY_CODE, text: 'No-Go Zone' },
        no_stopping: { code: NO_STOP_ENTRY_CODE, text: 'No Stopping Zone' },
        high_risk: { code: ZONE_ENTRY_CODE, text: 'High Risk Area' },
      }[zoneType];
      await emitDeviceStatusAlert({
        deviceId, fleetNumber, licensePlate, signalCode: zoneConfig.code,
        alarmText: `Entering ${zoneConfig.text} in zone ${z.name}`,
        lat, lon, speed, ts: nowTs,
        extra: { zoneName: z.name, zoneType },
      });
    }
  }

  // Zone stops: immediate + >1min alerts, persistent tracking. Stop thresholds
  // are per zone type — high-risk/no-go zones flag at speed < 5, No-Stopping at < 10.
  // Zone category is an explicit flag (is_no_stopping), never a name match.
  for (const z of insideZones) {
    // Zone type for stop logic: no_go and high_risk use high_risk threshold; no_stopping uses its own
    const zoneType = z.is_no_stopping ? 'no_stopping' : 'high_risk';
    const stopThreshold = zoneType === 'high_risk' ? STOP_SPEED : STOP_SPEED_NO_STOPPING;
    const isStopped = Number(speed) < stopThreshold;
    const stopKey = `${deviceId}:${z.id}`;
    let stop = stopMap.get(stopKey);

    if (isStopped) {
      if (!stop) {
        stop = await db.startZoneStopEvent({
          deviceId, fleetNumber, licensePlate,
          zoneId: z.id, zoneName: z.name, zoneType, stoppedAt: nowTs,
        });
        if (stop) stopMap.set(stopKey, stop);
      }
      if (!stop) continue;

      // Immediate "Stopped High Risk area" on first stop poll — both zone types.
      if (!stop.immediate_alert_sent) {
        await emitDeviceStatusAlert({
          deviceId, fleetNumber, licensePlate, signalCode: ZONE_STOP_IMMEDIATE_CODE,
          alarmText: `Stopped ${zoneType === 'high_risk' ? 'High Risk area' : 'No Stopping zone'} in ${z.name}`,
          lat, lon, speed, ts: nowTs,
          extra: { zoneName: z.name },
        });
        await db.markZoneStopAlertSent(stop.id, 'immediate');
      }

      // >1min stop alerts.
      if (!stop.minute_alert_sent) {
        const elapsedMs = Date.now() - new Date(stop.stop_start).getTime();
        if (elapsedMs >= 60000) {
          const signalCode = zoneType === 'high_risk' ? ZONE_STOP_1MIN_HIGH_CODE : ZONE_STOP_1MIN_NO_CODE;
          await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, signalCode,
            alarmText: `Stopped > 1min in ${zoneType === 'high_risk' ? 'High Risk area' : 'No Stopping zone'} ${z.name}`,
            lat, lon, speed, ts: nowTs,
            extra: { zoneName: z.name },
          });
          await db.markZoneStopAlertSent(stop.id, 'minute');
        }
      }
    } else if (stop) {
      // Moving again while inside → close the stop event.
      await db.endZoneStopEvent(stop.id, nowTs);
      stopMap.delete(stopKey);
    }
  }

  // Close stop events for zones we are no longer in.
  for (const [stopKey, stop] of [...stopMap.entries()]) {
    if (stopKey.startsWith(`${deviceId}:`) && !currentZoneIds.includes(stop.zone_id)) {
      await db.endZoneStopEvent(stop.id, nowTs);
      stopMap.delete(stopKey);
    }
  }

}

// ── Main poll ──

// ── Heartbeat + watchdog ──
// Every poll logs start/end with the last stage reached. The watchdog clears a
// poll that runs past POLL_STUCK_MS so the next tick can run, and logs the stage
// it was stuck in. A poll generation id stops a stale poll from clearing the
// flag of a newer one.
let pollGen = 0;
let pollStartedAt = 0;
let pollStage = 'idle';
let lastPollEndedAt = 0;
let lastPollMs = 0;
let lastPollError = null;
let watchdogTimer = null;
const fatigueDropLogged = new Set();
// Logs a drop reason once per key so gates are visible without flooding the log.
const dropLogged = new Set();
function logDropOnce(key, message) {
  if (dropLogged.has(key)) return;
  dropLogged.add(key);
  console.log(message);
}
const POLL_STUCK_MS = 60000;
const WATCHDOG_EVERY_MS = 15000;
const CAMERA_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const cameraCheckCache = new Map(); // deviceId -> last check timestamp

function markStage(name) { pollStage = name; }

function getPollHealth() {
  return {
    inFlight,
    stage: pollStage,
    startedAt: pollStartedAt ? new Date(pollStartedAt).toISOString() : null,
    runningMs: inFlight ? Date.now() - pollStartedAt : 0,
    lastEndedAt: lastPollEndedAt ? new Date(lastPollEndedAt).toISOString() : null,
    lastMs: lastPollMs,
    lastError: lastPollError,
  };
}

function watchdogTick() {
  if (!inFlight) return;
  const running = Date.now() - pollStartedAt;
  if (running > POLL_STUCK_MS) {
    console.error(`[DEVSTATUS] WATCHDOG: poll#${pollGen} stuck for ${running}ms at stage=${pollStage}; clearing so next tick runs`);
    lastPollError = `stuck at ${pollStage} for ${running}ms`;
    inFlight = false;
    pollGen++; // the stuck poll's finally must not touch the flag
  }
}

async function pollDeviceStatus() {
  if (inFlight) return;
  inFlight = true;
  const gen = ++pollGen;
  pollStartedAt = Date.now();
  markStage('auth');
  try {
    const credentials = await geotabAuthenticate();
    markStage('fetch-status');
    const response = await geotabFetch({
      method: 'Get',
      params: { typeName: 'DeviceStatusInfo', credentials },
      id: 10,
      jsonrpc: '2.0',
    });
    if (response.error) {
      console.error('[DEVSTATUS] DeviceStatusInfo error:', response.error.message);
      return;
    }
    const statuses = response.result || [];
    if (statuses.length === 0) return;

    markStage('load-caches');
    const [fleetSet, gMap, zones] = await Promise.all([getFleetSet(), getGeotabMap(), getZones()]);

    // Open entries whose zone is no longer watched (flag removed or zone deleted)
    // can never be closed by a fix, so close them here once per poll.
    markStage('close-unwatched-entries');
    try {
      const watchedIds = zones.map((z) => z.id);
      const closed = await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = COALESCE(exit_time, NOW())
         WHERE is_active = TRUE AND NOT (zone_id = ANY($1::text[]))`,
        [watchedIds]
      );
      if (closed.rowCount > 0) console.log(`[ZONE] closed ${closed.rowCount} entries for unwatched zones`);
    } catch (err) {
      console.error('[ZONE] unwatched-entry close failed:', err.message);
    }

    // Batch-load active zone entries + active stop events (single queries).
    markStage('load-entries');
    const activeEntries = await db.query('SELECT device_id, zone_id FROM high_risk_zone_entries WHERE is_active = TRUE')
      .then((r) => r.rows).catch(() => []);
    const activeStops = await db.query('SELECT * FROM zone_stop_events WHERE stop_end IS NULL')
      .then((r) => r.rows).catch(() => []);
    const entryMap = new Map();
    for (const e of activeEntries) {
      if (!entryMap.has(e.device_id)) entryMap.set(e.device_id, new Set());
      entryMap.get(e.device_id).add(e.zone_id);
    }
    const stopMap = new Map();
    for (const s of activeStops) stopMap.set(`${s.device_id}:${s.zone_id}`, s);

    // Batch-load current vehicle_status for all polled devices.
    const ids = statuses.map((d) => d.device?.id).filter(Boolean);
    const existingRows = await db.query('SELECT * FROM vehicle_status WHERE device_id = ANY($1::text[])', [ids])
      .then((r) => r.rows).catch(() => []);
    const vsMap = new Map(existingRows.map((r) => [r.device_id, r]));

    let positionUpdated = 0;
    let drivingChanged = 0;
    let freshCount = 0;
    let staleCount = 0;
    let offlineCount = 0;
    // Telemetry-history trail rows for this tick (device event time, not ours).
    const trailRows = [];

    markStage('device-loop');
    for (const d of statuses) {
      const deviceId = d.device?.id;
      if (!deviceId) continue;
      markStage(`device:${deviceId}`);
      const gDevice = gMap.get(deviceId);
      if (!gDevice) continue; // only known fleet devices

      const lat = d.latitude;
      const lon = d.longitude;
      const speed = d.speed;
      const dateTime = d.dateTime || new Date().toISOString();
      const fleetNumber = gDevice.fleetNumber;
      const licensePlate = gDevice.licensePlate;

      // Freshness gate — dateTime is the device's own event time; isDeviceCommunicating
      // tells us it is currently talking to Geotab. Both are per-event, so no DB lookup.
      const fixAgeMs = dateTime ? Date.now() - new Date(dateTime).getTime() : Infinity;
      const communicating = d.isDeviceCommunicating === true;
      const isFresh = communicating && fixAgeMs <= DATA_FRESH_MS;
      if (communicating) {
        if (isFresh) freshCount++;
        else staleCount++;
      } else {
        offlineCount++;
      }

      await db.upsertVehicleStatus(deviceId, {
        plate: gDevice.name || null,
        licensePlate,
        fleetNumber,
        speed: speed ?? null,
        latitude: lat ?? null,
        longitude: lon ?? null,
        lastLogTime: dateTime,
      });
      positionUpdated++;

      // Real online state (isDeviceCommunicating + duration).
      try {
        let onlineSince = null;
        if (communicating) {
          const durMs = parseGeotabDurationMs(d.currentStateDuration);
          if (durMs !== null && durMs >= 0) onlineSince = new Date(Date.now() - durMs).toISOString();
        }
        await db.query('UPDATE vehicle_status SET is_online = $2, online_since = $3 WHERE device_id = $1', [deviceId, communicating, onlineSince]);
      } catch { /* online state must never block the poll */ }

      const prevRow = vsMap.get(deviceId);
      const firstSeen = !prevRow;
      const prevDriving = prevRow?.is_driving ?? null; // null initially / unknown
      const currDriving = d.isDriving === true;
      const durMs = parseGeotabDurationMs(d.currentStateDuration);

      // First sighting (fresh setup/rebuild or never-seen device): store the
      // observed state + its duration as a SILENT baseline. No alerts fire —
      // measurement continues forward from this point:
      //   - fatigue: thresholds already crossed at baseline are pre-seeded as
      //     "already alerted" so only NEW thresholds fire later,
      //   - speed: flag is set if the vehicle is already speeding so the first
      //     alert only comes after a drop-then-re-cross,
      //   - zones: stops/entries are tracked but their alerts are suppressed.
      // An open driving session IS started for vehicles already on the road.
      if (firstSeen) {
        const spd0 = Number(speed) || 0;
        const curMinutes = durMs !== null ? durMs / 60000 : 0;
        // Fatigue pre-seed: empty so thresholds always fire on first check
        const preAlerted = [];
        const ccId = await findVehicleCostCenterId(fleetNumber || deviceId).catch(() => null);
        if (currDriving) {
          await db.startDrivingSession({
            deviceId, fleetNumber, registrationNumber: licensePlate,
            costCenterId: ccId, startedAt: dateTime,
          });
        }
        await db.updateVehicleStatusDriving(deviceId, {
          isDriving: currDriving,
          drivingSince: currDriving ? dateTime : null,
          currentStateDurationMs: durMs,
          maxSpeed: spd0,
          speed85Alerted: false,
          speed90Alerted: false,
          fatigueAlertedThresholds: preAlerted,
        });
        vsMap.set(deviceId, {
          ...(prevRow || {}), id: deviceId, is_driving: currDriving,
          speed_85_alerted: false, speed_90_alerted: false,
          fatigue_alerted_thresholds: JSON.stringify(preAlerted),
        });
      } else {
      // Driving transition — only when a stored value FLIPS. Restart-safe:
      // a stored true stays true until a false arrives (and vice versa).
      if (currDriving !== prevDriving) {
        if (currDriving) {
          const ccId = await findVehicleCostCenterId(fleetNumber || deviceId).catch(() => null);
          await db.startDrivingSession({
            deviceId, fleetNumber, registrationNumber: licensePlate,
            costCenterId: ccId, startedAt: dateTime,
          });
          // Pre-seed thresholds: empty so thresholds always fire on first check
          const preAlerted = [];
          await db.updateVehicleStatusDriving(deviceId, {
            isDriving: true,
            drivingSince: dateTime,
            currentStateDurationMs: durMs,
            maxSpeed: speed ?? 0,
            speed85Alerted: false,
            speed90Alerted: false,
            fatigueAlertedThresholds: preAlerted,
          });
        } else {
          await db.endDrivingSession(deviceId, dateTime);
          await db.updateVehicleStatusDriving(deviceId, {
            isDriving: false,
            drivingSince: null,
            currentStateDurationMs: durMs,
          });
        }
        drivingChanged++;
        vsMap.set(deviceId, { ...prevRow, is_driving: currDriving });
      } else {
        // Same state: keep duration + max speed fresh, never touch driving flags.
        await db.updateVehicleStatusDriving(deviceId, {
          currentStateDurationMs: durMs,
          maxSpeed: Math.max(Number(prevRow.max_speed_this_session) || 0, Number(speed) || 0),
        });
      }
      }

      if (wsBroadcast && lat != null && lon != null) {
        const currentZone = findCurrentZone(zones, lat, lon);
        wsBroadcast('vehicle_position', {
          device_id: deviceId,
          plate: gDevice.name || null,
          license_plate: licensePlate,
          fleet_number: fleetNumber,
          speed: speed ?? null,
          latitude: lat,
          longitude: lon,
          last_log_time: dateTime,
          current_zone: currentZone,
          is_driving: currDriving,
        });
      }

      // ── Alert checks: registered vehicles only, need coords ──
      if (firstSeen) continue; // baseline only — no alerts on first sighting
      if (!isRegisteredToken(fleetNumber, licensePlate, fleetSet)) continue;
      if (lat == null || lon == null) continue;

      // Fatigue from authoritative currentStateDuration — driving sessions only,
      // and only while the vehicle's data is fresh (dateTime recent + communicating).
      const alertedFatigue = (() => {
        try { return JSON.parse(prevRow.fatigue_alerted_thresholds || '[]'); } catch { return []; }
      })();
      const newFatigue = [...alertedFatigue];
      if (isFresh && currDriving && durMs !== null && durMs > 0) {
        const curMinutes = durMs / 60000;
        for (const t of FATIGUE_THRESHOLDS) {
          if (curMinutes >= t.minutes && !newFatigue.includes(t.signalCode)) {
            const groupRow = await emitDeviceStatusAlert({
              deviceId, fleetNumber, licensePlate, signalCode: t.signalCode,
              alarmText: `${defNameFor(t.signalCode)} exceeded (${t.minutes} min)`,
              lat, lon, speed, ts: dateTime,
              extra: { drivingMinutes: Math.round(curMinutes) },
            });
            // Record the threshold ONLY once its alert exists. A failed emit (gate,
            // missing definition, DB error) writes nothing, so it is retried on the
            // next poll instead of being silently consumed.
            if (groupRow) {
              newFatigue.push(t.signalCode);
            } else {
              const key = `${deviceId}:${t.signalCode}`;
              if (!fatigueDropLogged.has(key)) {
                fatigueDropLogged.add(key);
                console.log(`[FATIGUE] no alert created for ${fleetNumber || deviceId} ${t.minutes}h threshold (will retry); see the reason logged above`);
              }
            }
          }
        }
      }

      // Speed alerts — one alert per sustained episode. Fires on the first fresh
      // crossing; re-arms only after speed stays below the threshold for a dwell
      // window (~60s ≈ 4 polls) so brief dips don't re-trigger. Only fresh
      // readings may advance the episode state (stale dips can't re-arm).
      const spd = Number(speed);
      let s85 = !!prevRow.speed_85_alerted;
      let s90 = !!prevRow.speed_90_alerted;
      // Speeding diagnostics: log every snapshot at or above 80 km/h so a missed
      // alert can be explained from the data (fresh flag + prior alert state).
      if (spd >= 80) {
        console.log(`[SPEED-POLL] ${fleetNumber || deviceId} ${licensePlate || ''} spd=${spd} fresh=${isFresh} at=${dateTime} prev85=${s85} prev90=${s90}`);
      }
      let dwell85 = prevRow.speed_85_dwell_since ? new Date(prevRow.speed_85_dwell_since).getTime() : null;
      let dwell90 = prevRow.speed_90_dwell_since ? new Date(prevRow.speed_90_dwell_since).getTime() : null;

      if (isFresh) {
        const nowMs = Date.now();

        // Re-arm bookkeeping: while alerted, count a continuous below-threshold
        // dwell; a re-crossing resets it (same episode).
        if (spd < 90) {
          if (s90) {
            if (dwell90 === null) dwell90 = nowMs;
            else if (nowMs - dwell90 >= SPEED_REARM_DWELL_MS) { s90 = false; dwell90 = null; }
          }
        } else {
          dwell90 = null;
        }
        if (spd < 85) {
          if (s85) {
            if (dwell85 === null) dwell85 = nowMs;
            else if (nowMs - dwell85 >= SPEED_REARM_DWELL_MS) { s85 = false; dwell85 = null; }
          }
        } else {
          dwell85 = null;
        }

        // Only consume the threshold AFTER a successful emit (mirrors fatigue logic).
        // If emit returns null (no definition, DB error, feed dedupe), we retry next poll.
        if (spd >= 90 && !s90) {
          const groupRow = await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, signalCode: SPEED_90_CODE,
            alarmText: `Speed ${spd} km/h exceeded 90 km/h`,
            lat, lon, speed, ts: dateTime,
            extra: { speed: spd },
          });
          if (groupRow) {
            s90 = true;
            s85 = true; // 90 supersedes 85
            dwell90 = null;
            dwell85 = null;
          } else {
            logDropOnce(`speed90:${deviceId}`, `[SPEED] 90 km/h alert dropped for ${fleetNumber || deviceId} (will retry); reason logged above`);
          }
        } else if (spd >= 85 && !s85) {
          const groupRow = await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, signalCode: SPEED_85_CODE,
            alarmText: `Speed ${spd} km/h exceeded 85 km/h`,
            lat, lon, speed, ts: dateTime,
            extra: { speed: spd },
          });
          if (groupRow) {
            s85 = true;
            dwell85 = null;
          } else {
            logDropOnce(`speed85:${deviceId}`, `[SPEED] 85 km/h alert dropped for ${fleetNumber || deviceId} (will retry); reason logged above`);
          }
        }
      }

      const dwell85Ms = prevRow.speed_85_dwell_since ? new Date(prevRow.speed_85_dwell_since).getTime() : null;
      const dwell90Ms = prevRow.speed_90_dwell_since ? new Date(prevRow.speed_90_dwell_since).getTime() : null;
      if (s85 !== !!prevRow.speed_85_alerted || s90 !== !!prevRow.speed_90_alerted ||
          dwell85 !== dwell85Ms || dwell90 !== dwell90Ms ||
          newFatigue.join(',') !== alertedFatigue.join(',')) {
        await db.updateVehicleStatusDriving(deviceId, {
          speed85Alerted: s85,
          speed90Alerted: s90,
          speed85DwellSince: dwell85 !== null ? new Date(dwell85).toISOString() : null,
          speed90DwellSince: dwell90 !== null ? new Date(dwell90).toISOString() : null,
          fatigueAlertedThresholds: newFatigue,
        });
      }

      // Zone entry / stop monitoring — only while the fix is current, so stale
      // last-known positions can't create or extend zone events.
      if (isFresh) {
        const prevLat = prevRow?.latitude;
        const prevLon = prevRow?.longitude;
        await processZoneForDevice(deviceId, fleetNumber, licensePlate, lat, lon, speed, dateTime, zones, entryMap, stopMap, prevLat, prevLon);
      }

      // Camera offline check — only when vehicle is driving and data is fresh
      if (currDriving && isFresh) {
        const mettaxDeviceId = prevRow?.mettax_device_id || gDevice.mettaxDeviceId;
        if (mettaxDeviceId) {
          await checkCameraStatus(deviceId, fleetNumber, licensePlate, mettaxDeviceId);
        }
      }

      // Trail: every coordinate, keyed by the device's own event time.
      if (lat != null && lon != null) {
        trailRows.push([deviceId, fleetNumber || null, licensePlate || null, lat, lon, dateTime]);
      }
    }

    // Bulk trail write (one statement) + hourly rolling 12h prune.
    if (trailRows.length > 0) {
      try {
        const vals = [];
        const params = [];
        trailRows.forEach((r, i) => {
          const b = i * 6;
          params.push(...r);
          vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::timestamptz)`);
        });
        await db.query(
          `INSERT INTO telemetry_history (device_id, fleet_number, registration, lat, lon, event_time)
           VALUES ${vals.join(',')}
           ON CONFLICT (device_id, event_time) DO NOTHING`
          , params);
      } catch (err) {
        console.error('[TRAIL] write failed:', err.message);
      }
    }
    if (!lastTrailPruneAt || Date.now() - lastTrailPruneAt > 3600000) {
      lastTrailPruneAt = Date.now();
      try {
        const pruned = await db.query(
          `DELETE FROM telemetry_history WHERE event_time < NOW() - INTERVAL '12 hours'`);
        console.log(`[TRAIL] pruned ${pruned.rowCount || 0} rows older than 12h`);
      } catch (err) {
        console.error('[TRAIL] prune failed:', err.message);
      }
    }

    console.log(`[DEVSTATUS] poll: ${statuses.length} statuses, ${positionUpdated} positions, ${drivingChanged} driving transitions | fresh ${freshCount}, stale ${staleCount}, offline ${offlineCount}`);
    lastPollError = null;
  } catch (error) {
    lastPollError = `${pollStage}: ${error.message}`;
    console.error(`[DEVSTATUS] poll failed at stage=${pollStage}:`, error.message);
  } finally {
    if (gen === pollGen) {
      inFlight = false;
      lastPollEndedAt = Date.now();
      lastPollMs = lastPollEndedAt - pollStartedAt;
      console.log(`[DEVSTATUS] poll#${gen} end stage=${pollStage} ms=${lastPollMs}`);
    }
  }
}

function defNameFor(signalCode) {
  // Best-effort label for alert text; the authoritative name comes from the def.
  const m = FATIGUE_THRESHOLDS.find((t) => t.signalCode === signalCode);
  if (!m) return 'Driving duration';
  const labels = {
    'a43F6lFwgIUq_gkgmgSX08g': 'Driver Fatigue 3h',
    'aScBH27NHXUqTLcl8QcCo4g': 'Driver Fatigue 6h',
    'aXmPcWqFx3kKp1XKdQDQEYQ': '8 Hour Duration Check',
    'adT7lgnAOhEep8a1M4u09eg': 'Driver fatigue 9h',
    'aJ2f9avKM80Ch7JgyCqOl7A': '12 Hour Duration Check',
    'aTZcSSADJ60eeqxk2DNGkZA': '15 Hour Duration Check',
  };
  return labels[signalCode] || 'Driving duration';
}

// ── Control ──

function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

function startPoller(intervalMs = POLL_INTERVAL_MS) {
  if (pollTimer) clearInterval(pollTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  pollTimer = setInterval(() => {
    pollDeviceStatus().catch((err) => console.error('[DEVSTATUS] tick error:', err.message));
  }, intervalMs);
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_EVERY_MS);
  pollDeviceStatus().catch((err) => console.error('[DEVSTATUS] tick error:', err.message));
  console.log(`[DEVSTATUS] poller started (every ${intervalMs / 1000}s, watchdog ${POLL_STUCK_MS / 1000}s)`);
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function runOnce() {
  await pollDeviceStatus();
}

// Camera status check — calls Mettax gallery API to see if vehicle has recent screenshots
async function checkCameraStatus(deviceId, fleetNumber, licensePlate, mettaxDeviceId) {
  if (!mettaxDeviceId) return;
  const now = Date.now();
  const lastCheck = cameraCheckCache.get(deviceId) || 0;
  if (now - lastCheck < CAMERA_CHECK_INTERVAL_MS) return;
  cameraCheckCache.set(deviceId, now);

  try {
    const endTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const startTime = new Date(now - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    // Use the same apiClient that handles auth/token properly
    const apiClient = require('../helpers/apiClient');
    const response = await apiClient.makeRequest('/gallery/page/file/v2', {
      deviceIds: mettaxDeviceId,
      startTime,
      endTime,
      queryType: 'Device',
      pageSize: 10,
      pageIndex: 1,
    });
    const data = response?.data || {};
    const records = data?.records || [];
    const status = records.length > 0 ? 'online' : 'offline';
    const lastScreenshot = records.length > 0
      ? new Date(Math.max(...records.map(r => new Date(r.createTime).getTime()))).toISOString()
      : null;

    console.log(`[CAMERA] ${fleetNumber} (${mettaxDeviceId}): ${status}, ${records.length} screenshots in last 10min`);

    await db.query(
      `INSERT INTO camera_status (fleet_number, reg, time_logged, status, countdown, last_screenshot, mettax_device_id)
       VALUES ($1, $2, NOW(), $3, INTERVAL '0', $4, $5)
       ON CONFLICT (fleet_number) DO UPDATE SET
         reg = EXCLUDED.reg,
         time_logged = NOW(),
         status = EXCLUDED.status,
         countdown = NOW() - camera_status.time_logged,
         last_screenshot = EXCLUDED.last_screenshot,
         mettax_device_id = EXCLUDED.mettax_device_id,
         updated_at = NOW()`,
      [fleetNumber, licensePlate || null, status, lastScreenshot, mettaxDeviceId]
    ).catch(err => console.error(`[CAMERA] status update failed for ${fleetNumber}:`, err.message));
  } catch (err) {
    console.error(`[CAMERA] check failed for ${fleetNumber}:`, err.message);
  }
}

module.exports = { startPoller, stopPoller, runOnce, setWsBroadcast, pollDeviceStatus, parseGeotabDurationMs, invalidateZonesCache, getPollHealth };