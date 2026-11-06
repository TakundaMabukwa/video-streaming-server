// Server-Sent Events hub.
//
// One LISTEN connection per process (single instance), one stream per browser.
// Alert changes arrive through PostgreSQL NOTIFY from alert_groups triggers.
// Telemetry is coalesced in memory every second. Presence is in memory.

const { Client } = require('pg');
const db = require('../db');
const config = require('../config/config');
const { eventFromRow } = require('./alertEvents');
const { canSeeFleet } = require('./visibility');
const livePresence = require('./presence');
const zoneNotifications = require('../services/zoneNotifications');
const { resolveFleetNumber, normalizeFleetString } = require('../services/costCenterLookup');

const CHANNEL = 'video_alert_broadcast_channel';
const HEARTBEAT_MS = 20000;
const TELEMETRY_FLUSH_MS = 250;
const TELEMETRY_CHUNK_SIZE = 50;

const clients = new Set();
let listener = null;
let starting = false;
let stopping = false;
let heartbeatTimer = null;
let telemetryTimer = null;
let presenceTimer = null;
let reconnectTimer = null;
const pendingTelemetry = new Map();
const latestTelemetry = new Map();

function log(...args) {
  console.log('[LIVE]', ...args);
}

function sseData(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function write(client, event) {
  if (!client || client.closed) return false;
  try {
    const ok = client.res.write(sseData(event));
    if (!ok) client.slow = true;
    return ok;
  } catch (err) {
    log('client write failed:', err.message);
    dropClient(client);
    return false;
  }
}

function enqueueTelemetry(client, vehicles) {
  if (!client || client.closed || !Array.isArray(vehicles) || vehicles.length === 0) return;
  if (!client.telemetryPending) client.telemetryPending = new Map();
  for (const vehicle of vehicles) {
    const fleet = String(vehicle?.fleet_number || '').trim().toUpperCase();
    if (!fleet) continue;
    client.telemetryPending.set(fleet, { ...vehicle, fleet_number: fleet });
  }
  flushClientTelemetry(client);
}

function flushClientTelemetry(client) {
  if (!client || client.closed || client.slow || client.flushing) return;
  if (!client.telemetryPending || client.telemetryPending.size === 0) return;
  client.flushing = true;
  try {
    while (!client.closed && !client.slow && client.telemetryPending.size > 0) {
      const chunk = [];
      for (const [fleet, vehicle] of client.telemetryPending) {
        chunk.push(vehicle);
        client.telemetryPending.delete(fleet);
        if (chunk.length >= TELEMETRY_CHUNK_SIZE) break;
      }
      write(client, { type: 'TELEMETRY_UPDATE', at: Date.now(), vehicles: chunk });
    }
  } finally {
    client.flushing = false;
  }
}

function dropClient(client) {
  if (!client || client.closed) return;
  client.closed = true;
  clients.delete(client);
  try { client.res.end(); } catch { /* ignore */ }
}

async function visible(ccIds, fleetNumber) {
  try {
    return await canSeeFleet(ccIds, fleetNumber);
  } catch {
    return (ccIds || []).length === 0;
  }
}

async function broadcast(event) {
  if (!event || clients.size === 0) return;
  for (const client of Array.from(clients)) {
    if (client.replaying) {
      client.buffer.push(event);
      continue;
    }
    if (await visible(client.ccIds, event.fleet_number)) write(client, event);
  }
}

async function broadcastBatch(baseEvent, vehicles) {
  if (!vehicles || vehicles.length === 0 || clients.size === 0) return;
  for (const client of Array.from(clients)) {
    if (client.replaying) {
      client.buffer.push({ ...baseEvent, vehicles });
      continue;
    }
    enqueueTelemetry(client, vehicles);
  }
}

async function replayAlerts(client, sinceRevision) {
  const rows = await db.query(
    `SELECT * FROM alert_groups WHERE revision > $1 ORDER BY revision ASC`,
    [sinceRevision]
  ).catch(() => ({ rows: [] }));

  let last = sinceRevision;
  for (const row of rows.rows) {
    const event = eventFromRow(row);
    if (!event) continue;
    last = Math.max(last, Number(event.revision) || 0);
    if (await visible(client.ccIds, event.fleet_number)) write(client, event);
  }
  return last;
}

async function sendTelemetrySnapshot(client) {
  const result = await db.query(
    `SELECT device_id, fleet_number, plate, license_plate, speed, latitude, longitude, bearing,
            is_online, online_since, is_driving, driving_since, engine_on, ignition_on,
            last_log_time, current_state_duration
       FROM vehicle_status`
  ).catch(() => ({ rows: [] }));

  const vehicles = [];
  for (const row of result.rows) {
    const speed = row.speed == null ? null : Number(row.speed);
    if (!Number.isFinite(speed)) continue;
    let canonicalFleet = row.fleet_number
      ? normalizeFleetString(row.fleet_number).toUpperCase() || null
      : null;
    if (!canonicalFleet && row.license_plate) {
      try {
        canonicalFleet = await resolveFleetNumber({
          deviceId: row.device_id,
          vehicleRegistration: row.license_plate,
        });
        canonicalFleet = canonicalFleet
          ? normalizeFleetString(canonicalFleet).toUpperCase() || null
          : null;
      } catch { canonicalFleet = null; }
    }
    if (!canonicalFleet) continue;
    vehicles.push({
        fleet_number: canonicalFleet,
        device_id: row.device_id,
        plate: row.plate || null,
        license_plate: row.license_plate || null,
        speed,
        lat: row.latitude ?? null,
        lon: row.longitude ?? null,
        bearing: row.bearing == null || row.bearing === '' ? null : (Number.isFinite(Number(row.bearing)) ? Number(row.bearing) : null),
        is_online: row.is_driving === true,
        online_since: row.online_since || null,
        is_driving: row.is_driving ?? null,
        driving_since: row.driving_since || null,
        engine_on: row.engine_on ?? null,
        ignition_on: row.ignition_on ?? null,
        observed_at: row.last_log_time || null,
        last_log_time: row.last_log_time || null,
        current_state_duration: row.current_state_duration || null,
      received_at: Date.now(),
    });
  }
  const byFleet = new Map(vehicles.map((vehicle) => [vehicle.fleet_number, vehicle]));
  for (const [fleet, vehicle] of latestTelemetry) byFleet.set(fleet, vehicle);
  // Chunk initial telemetry too. A single 539-vehicle write exceeds Node's
  // response high-water mark and used to mark the client slow permanently.
  enqueueTelemetry(client, Array.from(byFleet.values()));
}

async function sendCameraSnapshot(client) {
  const result = await db.query(
    `SELECT fleet_number, status, last_screenshot, time_logged FROM camera_status`
  ).catch(() => ({ rows: [] }));
  for (const row of result.rows) {
    if (await visible(client.ccIds, row.fleet_number)) {
      write(client, {
        type: 'CAMERA_STATUS',
        fleet_number: row.fleet_number || null,
        status: row.status || null,
        last_screenshot: row.last_screenshot || null,
        at: row.time_logged ? new Date(row.time_logged).getTime() : Date.now(),
      });
    }
  }
}

async function sendPresenceSnapshot(client) {
  const snapshot = livePresence.snapshot();
  const fleets = {};
  for (const [fleet, users] of Object.entries(snapshot.fleets)) {
    if (await visible(client.ccIds, fleet)) fleets[fleet] = users;
  }
  const alertIds = Object.keys(snapshot.alerts);
  const alerts = {};
  if (alertIds.length > 0) {
    const rows = await db.query(
      'SELECT id, fleet_number FROM alert_groups WHERE id = ANY($1::int[])',
      [alertIds.map(Number).filter(Number.isInteger)]
    ).catch(() => ({ rows: [] }));
    const fleetById = new Map(rows.rows.map((r) => [String(r.id), r.fleet_number]));
    for (const id of alertIds) {
      if (await visible(client.ccIds, fleetById.get(id))) alerts[id] = snapshot.alerts[id];
    }
  }
  write(client, { type: 'PRESENCE_SNAPSHOT', fleets, alerts });
}

async function sendZoneNotificationSnapshot(client) {
  const rows = zoneNotifications.snapshot();
  const notifications = [];
  for (const row of rows) {
    if (await visible(client.ccIds, row.fleet_number)) notifications.push(row);
  }
  write(client, { type: 'ZONE_NOTIFICATION_SNAPSHOT', notifications, at: Date.now() });
}

async function addClient({ res, identity, ccIds, sinceRevision }) {
  const client = {
    res,
    userId: identity?.id || null,
    email: identity?.email || null,
    ccIds: Array.isArray(ccIds) ? ccIds : [],
    replaying: true,
    buffer: [],
    slow: false,
    closed: false,
    flushing: false,
    telemetryPending: new Map(),
  };
  clients.add(client);
  res.on('close', () => dropClient(client));
  res.on('error', () => dropClient(client));
  res.on('drain', () => {
    client.slow = false;
    flushClientTelemetry(client);
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try { res.flushHeaders?.(); } catch { /* ignore */ }
  write(client, { type: 'CONNECTED', at: Date.now() });

  let since = Number(sinceRevision);
  if (!Number.isFinite(since) || since < 0) {
    const max = await db.query('SELECT COALESCE(MAX(revision), 0) AS max FROM alert_groups')
      .then((r) => Number(r.rows[0]?.max || 0))
      .catch(() => 0);
    since = max;
  }

  let lastRevision = since;
  try {
    lastRevision = await replayAlerts(client, since);
  } catch (err) {
    log('replay failed:', err.message);
  }

  // Snapshots are sent after replay so the client has a current baseline.
  await sendTelemetrySnapshot(client);
  await sendCameraSnapshot(client);
  await sendPresenceSnapshot(client);
  await sendZoneNotificationSnapshot(client);

  client.replaying = false;
  const buffered = client.buffer;
  client.buffer = [];
  for (const event of buffered) {
    const rev = Number(event.revision);
    if (Number.isFinite(rev) && rev <= lastRevision) continue;
    if (event.type === 'TELEMETRY_UPDATE') {
      enqueueTelemetry(client, event.vehicles || []);
    } else if (await visible(client.ccIds, event.fleet_number)) {
      write(client, event);
    }
  }

  write(client, { type: 'READY', asOfRevision: lastRevision, at: Date.now() });
  return client;
}

function publishTelemetry(payload) {
  if (!payload) return;
  const fleet = String(payload.fleet_number || '').trim().toUpperCase();
  if (!fleet) return;
  const speed = payload.speed == null || payload.speed === "" ? NaN : Number(payload.speed);
  // A status-only offline update may have no current speed; the client keeps
  // its last known speed. Other speedless updates are ignored.
  if (!Number.isFinite(speed) && payload.is_online !== false) return;
  const vehicle = {
    fleet_number: fleet,
    device_id: payload.device_id || null,
    plate: payload.plate || null,
    license_plate: payload.license_plate || null,
    speed: Number.isFinite(speed) ? speed : null,
    lat: payload.lat ?? payload.latitude ?? null,
    lon: payload.lon ?? payload.longitude ?? null,
    bearing: payload.bearing == null || payload.bearing === '' ? null : (Number.isFinite(Number(payload.bearing)) ? Number(payload.bearing) : null),
    is_online: payload.is_online ?? null,
    online_since: payload.online_since || null,
    is_driving: payload.is_driving ?? null,
    driving_since: payload.driving_since || null,
    engine_on: payload.engine_on ?? null,
    ignition_on: payload.ignition_on ?? null,
    observed_at: payload.observed_at || payload.last_log_time || null,
    last_log_time: payload.last_log_time || null,
    source: payload.source || null,
    current_zone: payload.current_zone || null,
    driver: payload.driver || payload.driver_name || null,
    sequence: Number(payload.sequence) || 0,
    received_at: Number(payload.received_at) || Date.now(),
  };
  pendingTelemetry.set(fleet, vehicle);
  if (Number.isFinite(speed)) latestTelemetry.set(fleet, vehicle);
  else {
    const previous = latestTelemetry.get(fleet);
    if (previous) latestTelemetry.set(fleet, { ...previous, is_online: vehicle.is_online, observed_at: vehicle.observed_at, received_at: vehicle.received_at });
  }
}

function publishCamera(payload) {
  if (!payload || !payload.fleet_number) return;
  broadcast({
    type: 'CAMERA_STATUS',
    fleet_number: payload.fleet_number,
    status: payload.status || null,
    last_screenshot: payload.last_screenshot || null,
    at: payload.at || Date.now(),
  }).catch(() => {});
}

function publishPresence(payload) {
  if (!payload) return;
  broadcast(payload).catch(() => {});
}

async function flushTelemetry() {
  if (pendingTelemetry.size === 0) return;
  const vehicles = Array.from(pendingTelemetry.values());
  pendingTelemetry.clear();
  await broadcastBatch({ type: 'TELEMETRY_UPDATE', at: Date.now() }, vehicles);
}

function handleNotification(msg) {
  let event = null;
  try { event = JSON.parse(msg.payload || '{}'); } catch { return; }
  if (!event || !event.type) return;
  broadcast(event).catch((err) => log('broadcast failed:', err.message));
}

async function startListener() {
  if (stopping) return;
  if (listener) return;
  starting = true;
  const client = new Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
    log(`listening on ${CHANNEL}`);
    client.on('notification', handleNotification);
    client.on('error', (err) => {
      log('listener error:', err.message);
      if (listener === client) listener = null;
      try { client.end().catch(() => {}); } catch { /* ignore */ }
      if (!stopping) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { startListener().catch(() => {}); }, 5000);
      }
    });
    client.on('end', () => {
      if (listener === client) listener = null;
      if (!stopping) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { startListener().catch(() => {}); }, 5000);
      }
    });
  } catch (err) {
    try { await client.end(); } catch { /* ignore */ }
    listener = null;
    if (!stopping) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { startListener().catch(() => {}); }, 5000);
    }
    log('listener connect failed:', err.message);
  } finally {
    starting = false;
  }
}

function start() {
  if (heartbeatTimer || telemetryTimer || presenceTimer) return;
  stopping = false;
  zoneNotifications.setBroadcast(broadcast);
  zoneNotifications.start();
  startListener().catch(() => {});
  heartbeatTimer = setInterval(() => {
    for (const client of Array.from(clients)) {
      try {
        const ok = client.res.write(': keepalive\n\n');
        if (!ok) client.slow = true;
      } catch {
        dropClient(client);
      }
    }
  }, HEARTBEAT_MS);
  telemetryTimer = setInterval(() => { flushTelemetry().catch(() => {}); }, TELEMETRY_FLUSH_MS);
  presenceTimer = setInterval(() => livePresence.sweep(), 30000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  if (typeof telemetryTimer.unref === 'function') telemetryTimer.unref();
  if (typeof presenceTimer.unref === 'function') presenceTimer.unref();
}

async function stop() {
  stopping = true;
  zoneNotifications.stop();
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  heartbeatTimer = null;
  telemetryTimer = null;
  presenceTimer = null;
  for (const client of Array.from(clients)) dropClient(client);
  if (listener) {
    const current = listener;
    listener = null;
    try { await current.end(); } catch { /* ignore */ }
  }
}

function getHealth() {
  return {
    clients: clients.size,
    listening: !!listener,
    pendingTelemetry: pendingTelemetry.size,
    latestTelemetry: latestTelemetry.size,
    backpressuredClients: Array.from(clients).filter((client) => client.slow).length,
  };
}

module.exports = {
  addClient,
  start,
  stop,
  getHealth,
  publishTelemetry,
  publishCamera,
  publishPresence,
  dropClient,
};
