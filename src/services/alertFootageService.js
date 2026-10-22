// Incident footage capture.
//
// For collision-type alerts we ask the camera system for the footage around
// the ALERT TIME (not the time we happen to run) and STORE the link, so the
// footage can be watched later without requesting it again.
//
// Window: 30s before -> 30s after the alert. All channels of the vehicle.
const db = require('../db');
const apiClient = require('../helpers/apiClient');

// Only these alert types request footage.
const FOOTAGE_ALARM_TYPES = [
  'possible collision',
  'possible collision (legacy)',
  'major collision',
  'minor collision',
  'forward collision',
];

const WINDOW_BEFORE_SEC = 30;
const WINDOW_AFTER_SEC = 30;
const SAST_OFFSET_MIN = 120;

function isFootageAlarmType(alarmType) {
  const t = String(alarmType || '').trim().toLowerCase();
  if (!t) return false;
  return FOOTAGE_ALARM_TYPES.includes(t);
}

// "YYYY-MM-DD HH:mm:ss" in SAST (the camera API works in SAST wall time).
function toSastStamp(date) {
  const shifted = new Date(date.getTime() + SAST_OFFSET_MIN * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
}

let deviceCache = { at: 0, rows: [] };
const DEVICE_CACHE_MS = 5 * 60 * 1000;

// Camera devices with their plate names and channels.
async function cameraDevices(force = false) {
  if (!force && Date.now() - deviceCache.at < DEVICE_CACHE_MS && deviceCache.rows.length) {
    return deviceCache.rows;
  }
  const tree = await apiClient.makeRequest('/customer/tree', { customerId: null });
  if (tree.code !== 0 || !tree.data) {
    throw new Error(tree.msg || 'Could not resolve the customer tree');
  }
  const customerId = Array.isArray(tree.data) ? tree.data[0]?.id : tree.data?.id;
  if (!customerId) throw new Error('No customer id available');
  const shadow = await apiClient.makeRequest('/device/shadow/customer', { customerId });
  if (shadow.code !== 0 || !shadow.data) {
    throw new Error(shadow.msg || 'Could not load the camera device list');
  }
  const rows = Array.isArray(shadow.data) ? shadow.data : [];
  deviceCache = { at: Date.now(), rows };
  return rows;
}

// Match a vehicle to its camera device + channels.
async function resolveVehicleCamera({ fleetNumber, registration, deviceId }) {
  const rows = await cameraDevices();
  const fleet = String(fleetNumber || '').trim().toUpperCase();
  const reg = String(registration || '').trim().toUpperCase();

  // Direct camera device id (video-sourced alerts already carry it).
  if (deviceId) {
    const direct = rows.find((r) => String(r?.deviceId || '') === String(deviceId));
    if (direct) return { deviceId: String(direct.deviceId), plate: direct.plateName || null, channels: channelIdsOf(direct) };
  }

  // Otherwise match on the plate name ("FLEET - REG" or "REG").
  for (const r of rows) {
    const plate = String(r?.plateName || '').trim().toUpperCase();
    if (!plate) continue;
    const parts = plate.split(' - ').map((x) => x.trim().toUpperCase());
    const hit =
      (fleet && (plate === fleet || parts.includes(fleet))) ||
      (reg && (plate === reg || parts.includes(reg)));
    if (hit) {
      return { deviceId: String(r.deviceId || ''), plate: r.plateName || null, channels: channelIdsOf(r) };
    }
  }
  return null;
}

function channelIdsOf(device) {
  const raw = device?.channels;
  const list = Array.isArray(raw) ? raw : [];
  const ids = list
    .map((c) => Number(c?.id ?? c?.channelId ?? c))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ids.length ? [...new Set(ids)].sort((a, b) => a - b) : [1];
}

// Ask the camera for the replay of a window on one channel.
async function requestReplay({ deviceId, channelId, startTime, endTime }) {
  const res = await apiClient.makeRequest('/video/history/replay', {
    deviceId,
    channelId: Number(channelId),
    playbackType: 0,
    fastForwardOrBackward: 0,
    startTime,
    endTime,
  });
  if (res.code === 0 && res.data) return { url: String(res.data), kind: 'replay' };
  return { url: null, kind: 'replay', error: res.msg || 'No replay available' };
}

// Fallback: ask the camera to upload the window, then read the resulting file.
async function requestUpload({ deviceId, channelId, startTime, endTime }) {
  const created = await apiClient.makeRequest('/video/history/upload', {
    deviceId,
    channelId: Number(channelId),
    startTime,
    endTime,
  });
  if (created.code !== 0 || !created.data) {
    return { url: null, kind: 'file', error: created.msg || 'Upload task could not be created' };
  }
  const taskId = created.data;
  for (let attempt = 0; attempt < 6; attempt++) {
    const task = await apiClient.makeRequest('/video/history/upload/task', { taskId });
    const rows = Array.isArray(task?.data) ? task.data : (task?.data ? [task.data] : []);
    const done = rows.find((r) => r?.fileUrl || r?.url);
    if (done) return { url: String(done.fileUrl || done.url), kind: 'file' };
    if (task?.code !== 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { url: null, kind: 'file', error: 'Upload did not complete in time' };
}

/**
 * Capture footage for one collision alert and store the links.
 * @param {object} payload { alertId, alertGroupId, deviceId, fleetNumber, registration, alarmType, alertTime }
 */
async function captureIncidentFootage(payload = {}) {
  const {
    alertId = null,
    alertGroupId = null,
    deviceId = null,
    fleetNumber = null,
    registration = null,
    alarmType = null,
    alertTime = null,
  } = payload;

  if (!isFootageAlarmType(alarmType)) {
    return { skipped: true, reason: `no footage requested for "${alarmType}"` };
  }

  const camera = await resolveVehicleCamera({ fleetNumber, registration, deviceId });
  if (!camera || !camera.deviceId) {
    throw new Error(`No camera device found for ${fleetNumber || registration || 'the vehicle'}`);
  }

  const when = alertTime ? new Date(alertTime) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error('Invalid alert time');
  const start = new Date(when.getTime() - WINDOW_BEFORE_SEC * 1000);
  const end = new Date(when.getTime() + WINDOW_AFTER_SEC * 1000);
  const startTime = toSastStamp(start);
  const endTime = toSastStamp(end);

  const results = [];
  for (const channelId of camera.channels) {
    let outcome = await requestReplay({ deviceId: camera.deviceId, channelId, startTime, endTime });
    if (!outcome.url) {
      const upload = await requestUpload({ deviceId: camera.deviceId, channelId, startTime, endTime });
      outcome = upload.url ? upload : outcome;
    }
    const row = {
      alertId,
      alertGroupId,
      deviceId: camera.deviceId,
      fleetNumber,
      registration,
      channelId,
      alarmType,
      videoUrl: outcome.url || null,
      kind: outcome.kind || 'replay',
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      status: outcome.url ? 'READY' : 'FAILED',
      error: outcome.url ? null : String(outcome.error || 'no footage').slice(0, 300),
    };
    // One row per (alert, channel): replace whatever was there before.
    await db.query(
      `DELETE FROM alert_footage WHERE alert_id IS NOT DISTINCT FROM $1 AND channel_id = $6`,
      [row.alertId, row.alertGroupId, row.deviceId, row.fleetNumber, row.registration, row.channelId]
    ).catch(() => {});
    await db.query(
      `INSERT INTO alert_footage
         (alert_id, alert_group_id, device_id, fleet_number, registration, channel_id,
          alarm_type, video_url, kind, window_start, window_end, status, error, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        row.alertId, row.alertGroupId, row.deviceId, row.fleetNumber, row.registration,
        row.channelId, row.alarmType, row.videoUrl, row.kind, row.windowStart, row.windowEnd,
        row.status, row.error, 'system',
      ]
    ).catch(() => {});
    results.push(row);
  }

  const ready = results.filter((r) => r.status === 'READY').length;
  console.log(
    `[FOOTAGE] ${fleetNumber || registration}: ${ready}/${results.length} channel(s) captured for "${alarmType}"`
  );
  return { captured: ready, channels: results.length, deviceId: camera.deviceId, rows: results };
}

/** Footage rows for the dashboard tab. */
async function listFootage({ deviceId = null, fleetNumber = null, status = null, limit = 500 } = {}) {
  const conditions = [];
  const params = [];
  if (deviceId) {
    params.push(String(deviceId));
    conditions.push(`device_id = $${params.length}`);
  }
  if (fleetNumber) {
    params.push(String(fleetNumber));
    conditions.push(`upper(trim(coalesce(fleet_number,''))) = upper($${params.length})`);
  }
  if (status) {
    params.push(String(status).toUpperCase());
    conditions.push(`status = $${params.length}`);
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, alert_id, alert_group_id, device_id, fleet_number, registration, channel_id,
            alarm_type, video_url, kind, window_start, window_end, status, error, created_at
     FROM alert_footage ${where}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** Distinct vehicles that have footage. */
async function listFootageDevices() {
  const { rows } = await db.query(
    `SELECT device_id,
            max(fleet_number) AS fleet_number,
            max(registration) AS registration,
            count(*)::int AS clips,
            count(*) FILTER (WHERE status = 'READY')::int AS ready,
            max(created_at) AS last_at
     FROM alert_footage
     WHERE device_id IS NOT NULL AND device_id <> ''
     GROUP BY device_id
     ORDER BY last_at DESC`
  );
  return rows;
}

module.exports = {
  captureIncidentFootage,
  listFootage,
  listFootageDevices,
  isFootageAlarmType,
  FOOTAGE_ALARM_TYPES,
};
