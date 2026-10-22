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
  return formatCameraTime(date, SAST_OFFSET_MIN);
}

let deviceCache = { at: 0, rows: [] };
const DEVICE_CACHE_MS = 5 * 60 * 1000;

// The camera device list (id, plate name, channel count) — the same
// /device/page feed the stream controller uses.
async function cameraDevices(force = false) {
  if (!force && Date.now() - deviceCache.at < DEVICE_CACHE_MS && deviceCache.rows.length) {
    return deviceCache.rows;
  }
  const rows = [];
  let pageIndex = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await apiClient.makeRequest(
      '/device/page',
      { pageIndex, pageSize: 100, subsumption: true },
      15000
    );
    if (res.code !== 0 || !Array.isArray(res.data?.records) || res.data.records.length === 0) {
      hasMore = false;
      break;
    }
    rows.push(...res.data.records);
    pageIndex += 1;
    hasMore = res.data.records.length === 100;
    if (pageIndex > 20) hasMore = false;
  }
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
    const direct = rows.find((r) => String(r?.id || '') === String(deviceId));
    if (direct) {
      return {
        deviceId: String(direct.id),
        plate: direct.deviceName || null,
        channels: channelIdsOf(direct),
        offsetMinutes: timezoneOffsetMinutes(direct),
      };
    }
  }

  // Otherwise match on the plate name ("FLEET - REG" or "REG").
  for (const r of rows) {
    const plate = String(r?.deviceName || '').trim().toUpperCase();
    if (!plate) continue;
    const parts = plate.split(' - ').map((x) => x.trim().toUpperCase());
    const hit =
      (fleet && (plate === fleet || parts.includes(fleet))) ||
      (reg && (plate === reg || parts.includes(reg)));
    if (hit) {
      return {
        deviceId: String(r.id || ''),
        plate: r.deviceName || null,
        channels: channelIdsOf(r),
        offsetMinutes: timezoneOffsetMinutes(r),
      };
    }
  }
  return null;
}

// A device's channels: camCount channels, numbered from 1 (as the Playback
// tab and the stream controller do).
function channelIdsOf(device) {
  const count = Number(device?.camCount || 0);
  if (Number.isFinite(count) && count > 0) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  return [1];
}

// The camera API wants plain local times ("YYYY-MM-DD HH:mm:ss") in the
// device's own timezone (UTC+02:00 for the fleet). Everything we send and
// compare — replay windows, uploaded file times — uses this format.
function formatCameraTime(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

// The device's timezone offset in minutes ("UTC+02:00" -> 120).
function timezoneOffsetMinutes(device) {
  const tz = String(device?.timezone || 'UTC+02:00');
  const m = tz.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 120;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  return sign * (hours * 60 + minutes);
}

// Ask the camera for the replay of a window on one channel — the same call
// the Playback tab makes (live stream from the device).
async function requestReplay({ deviceId, channelId, startTime, endTime }) {
  const res = await apiClient.makeRequest(
    '/video/history/replay',
    {
      deviceId,
      channelId: Number(channelId),
      playbackType: 0,
      fastForwardOrBackward: 1,
      startTime,
      endTime,
    },
    10000
  );
  if (res.code === 0 && res.data) return { url: String(res.data), kind: 'replay' };
  return { url: null, kind: 'replay', error: res.msg || 'No replay available' };
}

// The footage the camera already uploaded for that window — the same cached
// upload tasks the Playback tab falls back to. We never create a new upload
// task: the footage must actually exist, not be queued for later.
let uploadTasksCache = { at: 0, rows: [] };
const UPLOAD_TASKS_TTL_MS = 60 * 1000;

async function getUploadTasks() {
  if (uploadTasksCache.rows.length > 0 && Date.now() - uploadTasksCache.at < UPLOAD_TASKS_TTL_MS) {
    return uploadTasksCache.rows;
  }
  const res = await apiClient.makeRequest(
    '/video/history/upload/task',
    { pageSize: 200, pageIndex: 1 },
    15000
  );
  if (res.code === 0 && Array.isArray(res.data?.records)) {
    uploadTasksCache = { at: Date.now(), rows: res.data.records };
  }
  return uploadTasksCache.rows;
}

// The uploaded file that covers the window (same matching as the Playback tab).
async function findUploadedFootage({ deviceId, channelId, startTime, endTime }) {
  const tasks = await getUploadTasks();
  const ready = (t) =>
    t && t.deviceId === deviceId && t.status === 1 && t.fileUrl && Number(t.channelId) === Number(channelId);
  let match = tasks.find(
    (t) => ready(t) && t.fileStartTime <= endTime && t.fileEndTime >= startTime
  );
  if (!match) match = tasks.find((t) => ready(t));
  if (!match) return { url: null, kind: 'file', error: 'No uploaded footage covers that window' };
  return { url: String(match.fileUrl), kind: 'file' };
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
  const offsetMinutes = camera.offsetMinutes ?? SAST_OFFSET_MIN;
  const startTime = formatCameraTime(start, offsetMinutes);
  const endTime = formatCameraTime(end, offsetMinutes);

  const results = [];
  for (const channelId of camera.channels) {
    // Live replay first, then the footage the camera already uploaded for
    // that window — the same two steps the Playback tab uses. No new upload
    // task is created: the footage has to actually exist.
    let outcome = await requestReplay({ deviceId: camera.deviceId, channelId, startTime, endTime });
    if (!outcome.url) {
      const uploaded = await findUploadedFootage({ deviceId: camera.deviceId, channelId, startTime, endTime });
      outcome = uploaded.url ? uploaded : outcome;
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
