const { WebSocket } = require('ws');
const db = require('../db');
const { getTelematicsNameMap } = require('../db/alert_definitions');
const { matchAlertDefinition } = require('../helpers/alertMatching');
const { batchInsertTelemetryHistory } = require('../db/telemetryHistory');
const soltrackZoneService = require('./soltrackZoneService');
const soltrackEngineSessionService = require('./soltrackEngineSessionService');
const { escalateSeverity } = require('../helpers/transform');
const sseHub = require('../live/sseHub');

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
let stopping = false;
let wsBroadcast = null;
let seq = 0;
let alertSeq = 0;

// In-memory fleet dictionary (refresh interval + after midnight sync).
// Normalized FLEET number -> { fleetNumber, registrationNumber, ccId, mettaxDeviceId }
const fleetDict = new Map();
let dictTimer = null;
const DICT_TTL = 15 * 60 * 1000;

// lastLogged[normalizedFleet] -> true, logs each unknown fleet once per process
const lastLogged = new Map();
const UNKNOWN_LOG_LIMIT = 20;
let unknownLogged = 0;

const stats = {
  msgs: 0,
  frames: 0,
  unknown: 0,
  matched: 0,
  noMatch: 0,
  positionsFlushed: 0,
  historyRows: 0,
  alertsQueued: 0,
};
let statsTimer = null;

// High-volume Soltrack protection:
// - positions coalesce in memory and flush in batches (one DB connection)
// - matched alerts are processed serially so the pool is never flooded
const POSITION_FLUSH_MS = 1000;
const POSITION_BATCH_SIZE = 200;
const HISTORY_BATCH_SIZE = 500;
const HISTORY_QUEUE_MAX = 20000;
const ZONE_CHECK_MIN_MS = 15000;
const ENGINE_CHECK_MIN_MS = 15000;
const ALERT_QUEUE_WARN_AT = 5000;
const positionBuffer = new Map();
const historyQueue = [];
const historyKeys = new Set();
let flushTimer = null;
let flushInFlight = false;
let historyFlushInFlight = false;
let lastHistoryErrorAt = 0;
const alertQueue = [];
let alertWorker = null;
const lastZoneCheck = new Map();
const lastEngineCheck = new Map();

function setWsBroadcast(fn) { wsBroadcast = fn; }

function normalizeReg(reg) {
  return String(reg || '').trim().replace(/\s+/g, '').toUpperCase();
}

// Load all fleet vehicles into memory once, then refresh on an interval.
// Frame-time vehicle resolution never touches the DB.
async function loadFleetDict() {
  let rows;
  try {
    rows = (await db.query(
      `SELECT fleet_number, registration_number, cost_center_id, mettax_device_id
         FROM fleet_vehicles
        WHERE fleet_number IS NOT NULL AND fleet_number <> ''`
    )).rows;
  } catch (err) {
    console.error('[SOLTRACK] Fleet dict load error:', err.message);
    return;
  }
  const next = new Map();
  for (const r of rows) {
    if (!r || !r.fleet_number || !r.registration_number) continue;
    const key = normalizeReg(r.registration_number);
    if (!key) continue;
    next.set(key, {
      fleetNumber: r.fleet_number,
      registrationNumber: r.registration_number || null,
      ccId: r.cost_center_id == null ? null : r.cost_center_id,
      mettaxDeviceId: r.mettax_device_id || null,
    });
  }
  fleetDict.clear();
  for (const [k, v] of next) fleetDict.set(k, v);
  console.log(`[SOLTRACK] Fleet dict refreshed: ${fleetDict.size} registration keys`);
}

// Pure in-memory resolution: the frame's first field is the FLEET number.
function resolveVehicle(fleet) {
  const key = normalizeReg(fleet);
  if (!key) return null;
  return fleetDict.get(key) || null;
}

/**
 * Parse a single Soltrack frame.
 * Layout (pipe-delimited, wrapped in ^...^):
 *   [0]=reg/fleet [1]=speed [2]=lat [3]=lon [4]=locTime [5]=mileage [6]=ip
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

// DB persistence of unknown regs is OFF by default: it opened one pool
// connection per distinct unknown reg and exhausted the pool. Set
// SOLTRACK_PERSIST_UNKNOWN=1 to re-enable. Counts stay in memory (stats.unknown).
const PERSIST_UNKNOWN = process.env.SOLTRACK_PERSIST_UNKNOWN === '1';

async function logUnknownVehicle(reg, frame) {
  if (!PERSIST_UNKNOWN) return;
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

async function flushPositions() {
  if (flushInFlight || positionBuffer.size === 0) return;
  flushInFlight = true;
  const rows = Array.from(positionBuffer.values());
  positionBuffer.clear();
  try {
    for (let i = 0; i < rows.length; i += POSITION_BATCH_SIZE) {
      await db.batchUpsertVehicleStatus(rows.slice(i, i + POSITION_BATCH_SIZE));
    }
    stats.positionsFlushed += rows.length;
  } catch (err) {
    console.error('[SOLTRACK] Position batch flush failed:', err.message);
  } finally {
    flushInFlight = false;
    if (positionBuffer.size > 0) setImmediate(() => { void flushPositions(); });
  }
}

function historyKey(row) {
  return `${row.device_id}|${row.event_time}`;
}

function queueTelemetryHistory({ fleetNumber, registration, lat, lon, eventTime }) {
  if (!fleetNumber || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const row = {
    device_id: fleetNumber,
    fleet_number: fleetNumber,
    registration: registration || null,
    lat,
    lon,
    event_time: eventTime.toISOString(),
  };
  const key = historyKey(row);
  if (historyKeys.has(key)) return;

  historyKeys.add(key);
  historyQueue.push(row);

  if (historyQueue.length > HISTORY_QUEUE_MAX) {
    const dropped = historyQueue.splice(0, historyQueue.length - HISTORY_QUEUE_MAX);
    for (const item of dropped) historyKeys.delete(historyKey(item));
    console.warn(`[SOLTRACK] History queue dropped ${dropped.length} rows`);
  }

  if (historyQueue.length >= HISTORY_BATCH_SIZE) void flushTelemetryHistory();
}

async function flushTelemetryHistory() {
  if (historyFlushInFlight || historyQueue.length === 0) return;
  historyFlushInFlight = true;
  try {
    while (historyQueue.length > 0) {
      const rows = historyQueue.splice(0, HISTORY_BATCH_SIZE);
      try {
        const inserted = await batchInsertTelemetryHistory(rows);
        stats.historyRows += inserted;
      } finally {
        for (const row of rows) historyKeys.delete(historyKey(row));
      }
    }
  } catch (err) {
    const now = Date.now();
    if (now - lastHistoryErrorAt > 60000) {
      lastHistoryErrorAt = now;
      console.error('[SOLTRACK] Telemetry history flush failed:', err.message);
    }
  } finally {
    historyFlushInFlight = false;
    if (historyQueue.length > 0) setImmediate(() => { void flushTelemetryHistory(); });
  }
}

function kickAlertWorker() {
  if (alertWorker) return;
  alertWorker = (async () => {
    while (alertQueue.length > 0) {
      const item = alertQueue.shift();
      try {
        await processSoltrackAlert(item);
      } catch (err) {
        console.error('[SOLTRACK] Alert processing failed:', err.message);
      }
    }
  })().finally(() => {
    alertWorker = null;
    if (alertQueue.length > 0) kickAlertWorker();
  });
}

function enqueueAlert(item) {
  alertQueue.push(item);
  stats.alertsQueued++;
  if (alertQueue.length === ALERT_QUEUE_WARN_AT || alertQueue.length % ALERT_QUEUE_WARN_AT === 0) {
    console.warn(`[SOLTRACK] Alert queue backlog: ${alertQueue.length}`);
  }
  kickAlertWorker();
}

async function processSoltrackAlert({ frame, vehicle, plate, eventTime, speed, lat, lon, seqNo }) {
  const { fleetNumber, ccId, mettaxDeviceId } = vehicle;
  await soltrackEngineSessionService.handleEngineStatus({
    fleetNumber,
    registration: plate,
    costCenterId: ccId,
    status: frame.status,
    eventTime,
    speed,
    lat,
    lon,
  }).catch((err) => {
    console.error('[SOLTRACK] Engine status handling failed:', err.message);
  });

  const nameMap = await getTelematicsNameMap(ccId ? [ccId] : []).catch(() => ({}));
  const matchedDef = matchAlertDefinition(
    frame.status,
    nameMap.nameMap || {},
    nameMap.signalCodeMap || {}
  );

  if (!matchedDef) {
    stats.noMatch++;
    console.log(`[SOLTRACK] Status "${frame.status}" has no matching definition for fleet ${fleetNumber} (cc=${ccId || 'global'})`);
    return;
  }

  const alertId = `stl-${fleetNumber}-${Date.now()}-${++alertSeq || seqNo}`;
  const deviceName = `${fleetNumber}${plate ? ' - ' + plate : ''}`;
  const alarmText = `${frame.status}${frame.geoZone ? ' in zone ' + frame.geoZone : ''}`;
  const severity = String(matchedDef.severity || 'MEDIUM').toUpperCase();

  const alertPayload = {
    id: alertId,
    alertId,
    deviceId: fleetNumber,
    deviceName,
    alarmType: matchedDef.name,
    alarmText,
    alarmTs: eventTime,
    lat,
    lon,
    speed: speed ?? null,
    severity,
    fleetNumber,
    sourceType: 'telematics',
    sourceDeviceId: plate,
    mettaxDeviceId,
  };

  // Raw alert history (same store as video/MetTax alerts).
  await db.ensureMemberRow({ ...alertPayload, groupId: null });

  const alertCombos = require('./alertCombos');
  const comboResult = await alertCombos.handleDetection({
    alertId,
    deviceId: fleetNumber,
    deviceName,
    alarmType: matchedDef.name,
    alarmText,
    alarmTs: eventTime,
    lat,
    lon,
    speed: speed ?? null,
    severity: String(matchedDef.severity || 'MEDIUM').toLowerCase(),
    fleetNumber,
    sourceType: 'telematics',
    costCenterId: ccId,
    sourceDeviceId: plate,
    mettaxDeviceId,
  });

  // Additive combos: the individual card is raised unconditionally; a completed
  // combo only appends its merged card. Neither suppresses the other.
  const individual = await db.upsertAlertGroup({
    ...alertPayload,
    severity: String(matchedDef.severity || 'MEDIUM').toLowerCase(),
    registration: plate,
    costCenterId: ccId,
  });
  const groupRows = [
    ...(individual ? [individual] : []),
    ...(comboResult.groupRows || []),
  ];

  const groupRow = groupRows[0] || null;
  if (groupRow) {
    // Link the raw alert to the raised/bumped group. ON CONFLICT fills the
    // group id without overwriting the original member data.
    await db.ensureMemberRow({ ...alertPayload, groupId: groupRow.id });
  }

  await db.query(
    `INSERT INTO telematics_events (device_id, vehicle_id, license_plate, fleet_number, plate,
      event_type, event_code, severity, latitude, longitude, speed, description, driver_name, zone_name, raw_data, event_time,
      source_device_id, mettax_device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT DO NOTHING`,
    [
      fleetNumber, fleetNumber, plate, fleetNumber, plate,
      matchedDef.name, null, severity,
      lat, lon, speed,
      frame.status, frame.driver || null, frame.geoZone || null,
      JSON.stringify(frame), eventTime, plate, mettaxDeviceId,
    ]
  );

  if (wsBroadcast) {
    // Broadcast every card this detection produced: the individual one always,
    // plus the merged combo card when it completed. Each carries its own type
    // and count so the board renders them as separate alerts.
    for (const g of groupRows) {
      try {
        const isCombo = g.combo_name != null;
        const broadcastType = isCombo ? String(g.alarm_type || matchedDef.name) : matchedDef.name;
        const broadcastText = isCombo
          ? `${broadcastType} — ${matchedDef.name} combined`
          : alarmText;
        const groupCount = Number(g?.count || 1) || 1;
        const baseSeverity = String(g?.severity || matchedDef.severity || 'MEDIUM').toLowerCase();
        const escalatedSeverity = escalateSeverity(baseSeverity, groupCount);
        const groupId = g?.id != null ? String(g.id) : '';
        if (!groupId) continue;
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
            alert_type: broadcastType,
            alarm_type: broadcastType,
            type: broadcastType,
            title: broadcastType,
            alarmText: broadcastText,
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
            combo: isCombo ? g.combo_name : undefined,
            group_key: g?.group_key || `${fleetNumber}:${broadcastType}`.toLowerCase(),
            lat,
            lon,
            fleet_number: fleetNumber,
            vehicle_registration: plate,
          },
        });
      } catch (_) { /* never block ingest on WS */ }
    }

    try {
      wsBroadcast('new_event', {
        id: alertId,
        deviceId: fleetNumber,
        fleetNumber,
        licensePlate: plate,
        eventType: matchedDef.name,
        eventCode: null,
        severity,
        latitude: lat,
        longitude: lon,
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
}

async function handleFrame(frame) {
  stats.frames++;
  const vehicle = resolveVehicle(frame.reg);
  if (!vehicle) {
    stats.unknown++;
    if (!lastLogged.has(normalizeReg(frame.reg))) {
      lastLogged.set(normalizeReg(frame.reg), true);
      if (unknownLogged < UNKNOWN_LOG_LIMIT) {
        unknownLogged++;
        console.log(`[SOLTRACK] Skipping unknown fleet=${frame.reg}`);
      }
    }
    await logUnknownVehicle(frame.reg, frame);
    return { matched: false, reason: 'unknown_vehicle' };
  }

  const { fleetNumber, registrationNumber, ccId, mettaxDeviceId } = vehicle;
  const plate = registrationNumber || frame.reg;
  const eventTime = parseEventTime(frame.locTime);
  const speed = frame.speed || 0;
  const lat = Number.isFinite(frame.lat) ? frame.lat : null;
  const lon = Number.isFinite(frame.lon) ? frame.lon : null;
  const seqNo = ++seq;

  if (lat != null && lon != null) {
    queueTelemetryHistory({ fleetNumber, registration: plate, lat, lon, eventTime });
  }

  const position = {
    device_id: fleetNumber,
    plate,
    license_plate: plate,
    fleet_number: fleetNumber,
    speed,
    lat,
    lon,
    latitude: lat,
    longitude: lon,
    bearing: null,
    observed_at: eventTime.toISOString(),
    last_log_time: eventTime.toISOString(),
    is_online: true,
    is_driving: speed > 0,
    source: 'soltrack',
    current_zone: frame.geoZone || null,
    driver: frame.driver || null,
    sequence: seqNo,
    received_at: Date.now(),
  };

  const existing = positionBuffer.get(fleetNumber);
  const isNewer = !existing || new Date(position.last_log_time) >= new Date(existing.last_log_time);
  if (isNewer) {
    positionBuffer.set(fleetNumber, position);
    if (positionBuffer.size >= 1000) void flushPositions();
    if (wsBroadcast) {
      try { wsBroadcast('vehicle_position', position); } catch (_) {}
    }
    try { sseHub.publishTelemetry(position); } catch (_) {}
  }

  if (lat != null && lon != null) {
    const last = lastZoneCheck.get(fleetNumber) || 0;
    if (Date.now() - last >= ZONE_CHECK_MIN_MS) {
      lastZoneCheck.set(fleetNumber, Date.now());
      soltrackZoneService.checkVehicleZones({
        fleetNumber,
        registration: plate,
        lat,
        lon,
        speed,
        eventTime,
      }).catch(err => {
        console.error('[SOLTRACK] Zone breach check error:', err.message);
      });
    }
  }

  if (lat != null && lon != null) {
    const lastEngine = lastEngineCheck.get(fleetNumber) || 0;
    if (Date.now() - lastEngine >= ENGINE_CHECK_MIN_MS) {
      lastEngineCheck.set(fleetNumber, Date.now());
      soltrackEngineSessionService.evaluateEngineThresholds({
        fleetNumber,
        registration: plate,
        lat,
        lon,
        speed,
        eventTime,
      }).catch(err => {
        console.error('[SOLTRACK] Engine threshold check error:', err.message);
      });
    }
  }

  if (frame.status) {
    enqueueAlert({ frame, vehicle, plate, eventTime, speed, lat, lon, seqNo });
  }

  return { matched: false, buffered: true };
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
  loadFleetDict()
    .catch(() => {})
    .finally(() => {
      if (!stopping) connect(url);
    });
  if (dictTimer) clearInterval(dictTimer);
  dictTimer = setInterval(loadFleetDict, DICT_TTL);
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    const s = stats;
    console.log(`[SOLTRACK] 60s: ${s.msgs} msgs, ${s.frames} frames, ${s.matched} matched, ${s.noMatch} no-match, ${s.unknown} unknown, ${s.positionsFlushed} positions flushed, ${s.historyRows} history rows, ${alertQueue.length} queued`);
    Object.assign(s, { msgs: 0, frames: 0, matched: 0, noMatch: 0, unknown: 0, positionsFlushed: 0, historyRows: 0, alertsQueued: 0 });
  }, 60 * 1000);
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => { void flushPositions(); void flushTelemetryHistory(); }, POSITION_FLUSH_MS);
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
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  void flushTelemetryHistory();
}

module.exports = {
  start,
  stop,
  setWsBroadcast,
  handleFrame,
  parseFrame,
  normalizeReg,
  refreshFleetDict: loadFleetDict,
  resolveVehicle,
  flushPositions,
  flushTelemetryHistory,
};
