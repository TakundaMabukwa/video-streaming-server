const { WebSocket } = require('ws');
const db = require('../db');
const { getTelematicsNameMap } = require('../db/alert_definitions');
const { findVehicleCostCenterId } = require('./costCenterLookup');
const { matchAlertDefinition } = require('../helpers/alertMatching');
const { checkZoneBreaches } = require('./geotabPolling');

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
let stopping = false;
let wsBroadcast = null;
let seq = 0;

// reg -> { fleetNumber, ccId, ts, negative } cache
const vehicleCache = new Map();
const VEHICLE_CACHE_TTL = 5 * 60 * 1000;
const NEGATIVE_CACHE_TTL = 60 * 1000;

function setWsBroadcast(fn) { wsBroadcast = fn; }

function normalizeReg(reg) {
  return String(reg || '').trim().replace(/\s+/g, '').toUpperCase();
}

/**
 * Parse a single Soltrack frame.
 * Layout (pipe-delimited, wrapped in ^...^):
 *   [0]=reg [1]=speed [2]=lat [3]=lon [4]=locTime [5]=mileage [6]=ip
 *   [7]=status [8]=diagnostics [9]=item/device name [10]=geoZone [11]=driver
 */
function parseFrame(line) {
  let s = String(line || '').trim();
  if (!s) return null;
  if (s.startsWith('^')) s = s.slice(1);
  if (s.endsWith('^')) s = s.slice(0, -1);
  const parts = s.split('|');
  const reg = (parts[0] || '').trim();
  if (!reg) return null;
  return {
    reg,
    speed: parseFloat(parts[1]) || 0,
    lat: parseFloat(parts[2]),
    lon: parseFloat(parts[3]),
    locTime: (parts[4] || '').trim(),
    mileage: (parts[5] || '').trim() || null,
    ip: (parts[6] || '').trim() || null,
    status: (parts[7] || '').trim() || null,
    deviceName: (parts[9] || '').trim() || null,
    geoZone: (parts[10] || '').trim() || null,
    driver: (parts[11] || '').trim() || null,
  };
}

async function resolveVehicle(reg) {
  const key = normalizeReg(reg);
  if (!key) return null;

  const cached = vehicleCache.get(key);
  if (cached && Date.now() - cached.ts < (cached.negative ? NEGATIVE_CACHE_TTL : VEHICLE_CACHE_TTL)) {
    return cached.negative ? null : cached;
  }

  let row = null;
  try {
    // Primary: match normalized registration_number (covers reg-based identifiers)
    row = (
      await db.query(
        `SELECT fleet_number, registration_number, cost_center_id FROM fleet_vehicles
         WHERE LOWER(REPLACE(TRIM(registration_number), ' ', '')) = $1
         LIMIT 1`,
        [String(key).toLowerCase()]
      )
    ).rows[0] || null;

    // Fallback: the frame reg may itself be a fleet_number
    if (!row) {
      row = (
        await db.query(
          'SELECT fleet_number, registration_number, cost_center_id FROM fleet_vehicles WHERE fleet_number = $1 LIMIT 1',
          [reg]
        )
      ).rows[0] || null;
    }
  } catch (err) {
    console.error('[SOLTRACK] Fleet lookup error:', err.message);
    row = null;
  }

  if (!row || !row.fleet_number) {
    vehicleCache.set(key, { negative: true, ts: Date.now() });
    return null;
  }

  let ccId = row.cost_center_id == null ? null : row.cost_center_id;
  if (ccId == null) {
    try { ccId = await findVehicleCostCenterId(row.fleet_number); } catch { ccId = null; }
  }

  const vehicle = { fleetNumber: row.fleet_number, ccId, ts: Date.now(), negative: false };
  vehicleCache.set(key, vehicle);
  return vehicle;
}

function parseEventTime(locTime, fallback = new Date()) {
  if (!locTime) return fallback;
  const clean = String(locTime).trim();
  const normalized = clean.includes('T') ? clean : clean.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

async function handleFrame(frame) {
  const vehicle = await resolveVehicle(frame.reg);
  if (!vehicle) {
    console.log(`[SOLTRACK] Skipping unknown vehicle reg=${frame.reg}`);
    return { matched: false, reason: 'unknown_vehicle' };
  }

  const { fleetNumber, ccId } = vehicle;
  const plate = frame.reg;
  const eventTime = parseEventTime(frame.locTime);
  const speed = frame.speed || 0;
  const nowSeq = ++seq;

  // ── 1. Realtime status (position broadcast + vehicle_status upsert) ──
  const position = {
    device_id: fleetNumber,
    plate,
    license_plate: plate,
    fleet_number: fleetNumber,
    speed,
    latitude: frame.lat,
    longitude: frame.lon,
    last_log_time: eventTime.toISOString(),
    current_zone: frame.geoZone || null,
    driver: frame.driver || null,
    source: 'soltrack',
  };
  if (wsBroadcast) {
    try { wsBroadcast('vehicle_position', position); } catch (_) {}
  }
  try {
    await db.upsertVehicleStatus(fleetNumber, {
      plate,
      licensePlate: plate,
      fleetNumber,
      speed,
      latitude: frame.lat,
      longitude: frame.lon,
      lastLogTime: eventTime.toISOString(),
    });
  } catch (err) {
    console.error('[SOLTRACK] vehicle_status upsert error:', err.message);
  }

  // ── 2. CC-aware status -> alert definition match (name only, no multicode) ──
  if (frame.status) {
    const nameMap = await getTelematicsNameMap(ccId ? [ccId] : []).catch(() => ({}));
    const matchedDef = matchAlertDefinition(frame.status, nameMap);

    if (matchedDef) {
      const alertId = `stl-${fleetNumber}-${Date.now()}-${nowSeq}`;
      const deviceName = `${fleetNumber}${plate ? ' - ' + plate : ''}`;
      const alarmText = `${frame.status}${frame.geoZone ? ' in zone ' + frame.geoZone : ''}`;
      const severity = String(matchedDef.severity || 'MEDIUM').toUpperCase();

      try {
        await db.upsertAlert({
          id: alertId,
          deviceId: fleetNumber,
          deviceName,
          alarmType: matchedDef.name,
          alarmTs: eventTime,
          lat: frame.lat,
          lon: frame.lon,
          alarmText,
          sourceType: 'telematics',
        });

        await db.upsertAlertGroup({
          deviceId: fleetNumber,
          deviceName,
          alarmType: matchedDef.name,
          alarmText,
          alertId,
          alarmTs: eventTime,
          lat: frame.lat,
          lon: frame.lon,
          sourceType: 'telematics',
        });

        await db.query(
          `INSERT INTO telematics_events (device_id, vehicle_id, license_plate, fleet_number, plate,
            event_type, event_code, severity, latitude, longitude, speed, description, driver_name, zone_name, raw_data, event_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            fleetNumber, fleetNumber, plate, fleetNumber, plate,
            matchedDef.name, null, severity,
            frame.lat, frame.lon, speed,
            frame.status, frame.driver || null, frame.geoZone || null,
            JSON.stringify(frame), eventTime,
          ]
        );

        if (wsBroadcast) {
          try {
            wsBroadcast('new_event', {
              id: alertId,
              deviceId: fleetNumber,
              fleetNumber,
              licensePlate: plate,
              eventType: matchedDef.name,
              eventCode: null,
              severity,
              latitude: frame.lat,
              longitude: frame.lon,
              speed,
              distance: null,
              durationSeconds: null,
              driverName: frame.driver || null,
              description: frame.status,
              zoneName: frame.geoZone || null,
              eventTime: eventTime.toISOString(),
              source: 'soltrack',
            });
          } catch (_) {}
        }

        console.log(`[SOLTRACK] Alert created: ${alertId} (${matchedDef.name}) for fleet ${fleetNumber} reg ${plate} status="${frame.status}"`);
        return { matched: true, alertId };
      } catch (err) {
        console.error('[SOLTRACK] Failed to store alert:', err.message);
        return { matched: true, error: err.message };
      }
    }

    console.log(`[SOLTRACK] Status "${frame.status}" has no matching definition for fleet ${fleetNumber} (cc=${ccId || 'global'})`);
  }

  // ── 3. High-risk geozone detection (persists + broadcasts zone_breach) ──
  if (frame.lat && frame.lon) {
    try {
      await checkZoneBreaches(fleetNumber, frame.lat, frame.lon, speed, fleetNumber, plate);
    } catch (err) {
      console.error('[SOLTRACK] Zone breach check error:', err.message);
    }
  }

  return { matched: false };
}

function handleRawMessage(raw) {
  const text = String(raw);
  // Frames may be batch-delivered or arrive one per message.
  const matches = text.match(/\^([^\n]*)\^/g) || [];
  const rawLines = matches.length > 0 ? matches : (text.includes('|') ? [text.trim()] : []);

  for (const line of rawLines) {
    const frame = parseFrame(line);
    if (!frame) continue;
    handleFrame(frame).catch((err) => {
      console.error('[SOLTRACK] Frame error:', err.message);
    });
  }
}

function start() {
  const url = process.env.SOLTRACK_WEBSOCKET_URL;
  if (!url) {
    console.log('[SOLTRACK] SOLTRACK_WEBSOCKET_URL not set - Soltrack client disabled');
    return;
  }
  stopping = false;
  connect(url);
}

function connect(url) {
  if (stopping) return;
  console.log(`[SOLTRACK] Connecting to ${url}...`);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[SOLTRACK] Connection error:', err.message);
    scheduleReconnect(url);
    return;
  }

  ws.on('open', () => {
    reconnectDelay = 5000;
    console.log(`[SOLTRACK] Connected to ${url}`);
  });

  ws.on('message', (raw) => handleRawMessage(raw));

  ws.on('error', (err) => console.error('[SOLTRACK] WS error:', err.message));

  ws.on('close', () => {
    ws = null;
    console.log(`[SOLTRACK] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    scheduleReconnect(url);
  });
}

function scheduleReconnect(url) {
  if (stopping) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(url);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

function stop() {
  stopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

module.exports = { start, stop, setWsBroadcast, handleFrame, parseFrame, normalizeReg };