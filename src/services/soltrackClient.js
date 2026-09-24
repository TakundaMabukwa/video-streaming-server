const { WebSocket } = require('ws');
const db = require('../db');
const { getTelematicsNameMap } = require('../db/alert_definitions');
const { matchAlertDefinition } = require('../helpers/alertMatching');
const { checkZoneBreaches } = require('./geotabPolling');
const { escalateSeverity } = require('../helpers/transform');

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
let stopping = false;
let wsBroadcast = null;
let seq = 0;

// In-memory fleet dictionary (refresh interval + after midnight sync).
// Normalized key -> { fleetNumber, ccId }
const fleetDict = new Map();
let dictTimer = null;
const DICT_TTL = 15 * 60 * 1000;

// lastLogged[normalizedReg] -> true, logs each unknown reg once per process
const lastLogged = new Map();

// Frame throughput counters for a periodic summary line
const stats = { msgs: 0, frames: 0, unknown: 0, matched: 0, noMatch: 0 };
let statsTimer = null;

function setWsBroadcast(fn) { wsBroadcast = fn; }

function normalizeReg(reg) {
  return String(reg || '').trim().replace(/\s+/g, '').toUpperCase();
}

// Load all fleet_vehicles into memory once, then refresh on an interval.
// Frame-time vehicle resolution never touches the DB.
async function loadFleetDict() {
  let rows;
  try {
    rows = (await db.query(
      `SELECT fleet_number, registration_number, cost_center_id FROM fleet_vehicles
       WHERE fleet_number IS NOT NULL AND fleet_number <> ''`
    )).rows;
  } catch (err) {
    console.error('[SOLTRACK] Fleet dict load error:', err.message);
    return;
  }
  const next = new Map();
  const fleets = new Set();
  for (const r of rows) {
    if (!r || !r.fleet_number) continue;
    fleets.add(r.fleet_number);
    const entry = { fleetNumber: r.fleet_number, ccId: r.cost_center_id == null ? null : r.cost_center_id };
    if (r.registration_number) next.set(normalizeReg(r.registration_number), entry);
    next.set(normalizeReg(r.fleet_number), entry);
  }
  fleetDict.clear();
  for (const [k, v] of next) fleetDict.set(k, { ...v });
  console.log(`[SOLTRACK] Fleet dict refreshed: ${fleetDict.size} keys for ${fleets.size} vehicles`);
}

// Pure in-memory resolution: reg may be a plate (registration_number) or a fleet code.
function resolveVehicle(reg) {
  const key = normalizeReg(reg);
  if (!key) return null;
  return fleetDict.get(key) || null;
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

function parseEventTime(locTime, fallback = new Date()) {
  if (!locTime) return fallback;
  const clean = String(locTime).trim();
  const normalized = clean.includes('T') ? clean : clean.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

// Unknown-vehicle write throttle: persist each reg at most once per 30s.
const lastUnknownWrite = new Map();
const UNKNOWN_WRITE_THROTTLE = 30 * 1000;

async function logUnknownVehicle(reg, frame) {
  const key = normalizeReg(reg);
  const now = Date.now();
  const lastWrite = lastUnknownWrite.get(key);
  if (lastWrite && now - lastWrite < UNKNOWN_WRITE_THROTTLE) return;
  lastUnknownWrite.set(key, now);
  try {
    await db.query(
      `INSERT INTO soltrack_unknown (reg, frame, reason, first_seen, last_seen, seen_count)
       VALUES ($1, $2, $3, now(), now(), 1)
       ON CONFLICT (upper(replace(trim(reg), ' ', ''))) DO UPDATE SET
         frame = COALESCE(EXCLUDED.frame, soltrack_unknown.frame),
         reason = EXCLUDED.reason,
         last_seen = now(),
         seen_count = soltrack_unknown.seen_count + 1`,
      [reg, JSON.stringify(frame), 'unknown_vehicle']
    );
  } catch (err) {
    // Non-critical: diagnostic buffer only
  }
}

async function handleFrame(frame) {
  stats.frames++;
  const vehicle = resolveVehicle(frame.reg);
  if (!vehicle) {
    stats.unknown++;
    if (!lastLogged.has(normalizeReg(frame.reg))) {
      lastLogged.set(normalizeReg(frame.reg), true);
      console.log(`[SOLTRACK] Skipping unknown vehicle reg=${frame.reg}`);
    }
    await logUnknownVehicle(frame.reg, frame);
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
    const matchedDef = matchAlertDefinition(frame.status, nameMap.nameMap || {}, nameMap.signalCodeMap || {});

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

        const groupRow = await db.upsertAlertGroup({
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
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT DO NOTHING`,
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
            const groupCount = Number(groupRow?.count || 1) || 1;
            const baseSeverity = String(severity || 'medium').toLowerCase();
            const escalatedSeverity = escalateSeverity(baseSeverity, groupCount);
            // Resolve targets alert_groups.id only — never the stl- event key.
            const groupId = groupRow?.id != null ? String(groupRow.id) : '';
            if (groupId) {
            wsBroadcast('new-alert', {
              alert: {
                id: groupId,
                alert_id: groupId,
                last_alert_id: alertId,
                alarmId: alertId,
                alarm_id: alertId,
                device_id: fleetNumber,
                deviceId: fleetNumber,
                vehicleId: fleetNumber,
                device_name: deviceName,
                deviceName,
                alert_type: matchedDef.name,
                alarm_type: matchedDef.name,
                type: matchedDef.name,
                title: matchedDef.name,
                alarmText,
                timestamp: new Date(eventTime).toISOString(),
                alarmTs: new Date(eventTime).toISOString(),
                last_occurrence: new Date(eventTime).toISOString(),
                source_type: 'telematics',
                severity: escalatedSeverity,
                priority: escalatedSeverity,
                base_severity: baseSeverity,
                escalated: escalatedSeverity !== baseSeverity,
                status: 'new',
                resolved: false,
                count: groupCount,
                group_key: groupRow?.group_key || `${fleetNumber}:${matchedDef.name}`.toLowerCase(),
                lat: frame.lat,
                lon: frame.lon,
                fleet_number: fleetNumber,
                vehicle_registration: plate,
              },
            });
            }
          } catch (_) { /* never block ingest on WS */ }
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
        stats.matched++;
        return { matched: true, alertId };
      } catch (err) {
        console.error('[SOLTRACK] Failed to store alert:', err.message);
        return { matched: true, error: err.message };
      }
    }

    console.log(`[SOLTRACK] Status "${frame.status}" has no matching definition for fleet ${fleetNumber} (cc=${ccId || 'global'})`);
    stats.noMatch++;
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
  stats.msgs++;
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
  loadFleetDict();
  if (dictTimer) clearInterval(dictTimer);
  dictTimer = setInterval(loadFleetDict, DICT_TTL);
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    const s = stats;
    console.log(`[SOLTRACK] 60s: ${s.msgs} msgs, ${s.frames} frames, ${s.matched} matched, ${s.noMatch} no-match, ${s.unknown} unknown`);
    Object.assign(s, { msgs: 0, frames: 0, matched: 0, noMatch: 0, unknown: 0 });
  }, 60 * 1000);
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
  if (dictTimer) { clearInterval(dictTimer); dictTimer = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}

module.exports = { start, stop, setWsBroadcast, handleFrame, parseFrame, normalizeReg, refreshFleetDict: loadFleetDict, resolveVehicle };