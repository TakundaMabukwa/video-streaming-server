// Incident footage capture.
//
// For collision-type alerts we ask the camera system for the footage around
// the ALERT TIME (not the time we happen to run) and STORE the links, so the
// footage can be watched later without requesting it again.
//
// Two links, because they behave completely differently:
//
//   replay_url -> the live history stream (/video/history/replay ->
//                <device>_<ch>.history.flv). Available within seconds, but
//                ONE-SHOT: it can only be watched right away.
//   file_url   -> the mp4 the camera uploaded for that exact period
//                (/video/history/upload -> upload task -> fileUrl). Durable:
//                a static file that can be played again at any time.
//
// Both are requested at the same time. video_url keeps the resolved primary
// (file_url preferred, else replay_url) so a consumer always has one link.
//
// The upload is only triggered when the footage does not exist yet: before
// asking the camera to upload anything we check the device's own history list
// and the upload task list for a file that already covers the period.
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
// A task that has not moved for this long never started (the camera was off).
const STUCK_AFTER_MIN = 10;

// How long the immediate attempt waits for the upload to complete before
// handing the rest to the job runner.

function isFootageAlarmType(alarmType) {
  const t = String(alarmType || '').trim().toLowerCase();
  if (!t) return false;
  return FOOTAGE_ALARM_TYPES.includes(t);
}

// ── Period ────────────────────────────────────────────────────────────────
// The requested period is the alert time ±30s — one minute of footage. That
// exact window is what we ask the camera for; the file it produces may be a
// bit wider (the camera records in whole minutes) and its real range is
// stored next to it.
function resolvePeriod(alertTime) {
  const when = alertTime ? new Date(alertTime) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error('Invalid alert time');
  const alertStart = new Date(when.getTime() - WINDOW_BEFORE_SEC * 1000);
  const alertEnd = new Date(when.getTime() + WINDOW_AFTER_SEC * 1000);
  return { when, alertStart, alertEnd, uploadStart: alertStart, uploadEnd: alertEnd };
}

// The camera API works in the device's own wall time
// ("YYYY-MM-DD HH:mm:ss", UTC+02:00 for the fleet).
function formatCameraTime(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

// The device's timezone offset in minutes ("UTC+02:00" -> 120).
function timezoneOffsetMinutes(device) {
  const tz = String(device?.timezone || 'UTC+02:00');
  const m = tz.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return SAST_OFFSET_MIN;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  return sign * (hours * 60 + minutes);
}

// A camera-local stamp ("YYYY-MM-DD HH:mm:ss") as an absolute instant, so it
// does not depend on the database timezone.
function cameraStampToIso(stamp, offsetMinutes) {
  if (!stamp) return null;
  const m = String(stamp).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Date(utc - offsetMinutes * 60 * 1000).toISOString();
}

// ── Camera devices ────────────────────────────────────────────────────────
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

// Every vehicle carries two cameras.
function channelIdsOf(device) {
  const count = Number(device?.camCount || 0);
  if (Number.isFinite(count) && count >= 2) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  return [1, 2];
}

// ── Replay (the one-shot stream) ──────────────────────────────────────────
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
  if (res.code === 0 && res.data) return { url: String(res.data), error: null };
  return { url: null, error: res.msg || 'No replay available' };
}

// ── The uploaded file ─────────────────────────────────────────────────────
// The device's own history list: the records it holds for the period, with
// the fileUrl once they have been uploaded.
async function listHistoryFiles({ deviceId, channelId, startTime, endTime }) {
  const res = await apiClient.makeRequest(
    '/video/history/list',
    { deviceId, channelId: Number(channelId), startTime, endTime },
    12000
  ).catch((err) => ({ code: -1, msg: err.message, data: [] }));
  if (res.code !== 0 || !Array.isArray(res.data)) return [];
  return res.data;
}

// The upload tasks (paged) — completed ones carry the fileUrl.
let uploadTasksCache = { at: 0, rows: [] };
const UPLOAD_TASKS_TTL_MS = 60 * 1000;

async function getUploadTasks(force = false) {
  if (!force && uploadTasksCache.rows.length > 0 && Date.now() - uploadTasksCache.at < UPLOAD_TASKS_TTL_MS) {
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

// One upload task, by id.
async function getUploadTask(taskId) {
  const res = await apiClient.makeRequest(
    '/video/history/upload/task',
    { taskId: String(taskId), pageSize: 10, pageIndex: 1 },
    15000
  );
  const rows = Array.isArray(res.data?.records) ? res.data.records : [];
  return rows[0] || null;
}

// Does a file already exist for that period? Two sources, both read-only:
//   1. the device's history list (fileUrl once uploaded)
//   2. the upload task list (a completed task carries the fileUrl)
// A file only counts when its own range covers the requested period.
async function findAlreadyUploaded({ deviceId, channelId, alertStart, alertEnd, uploadStart, uploadEnd }) {
  const reqStart = formatCameraTime(uploadStart, SAST_OFFSET_MIN);
  const reqEnd = formatCameraTime(uploadEnd, SAST_OFFSET_MIN);
  const neededStart = formatCameraTime(alertStart, SAST_OFFSET_MIN);
  const neededEnd = formatCameraTime(alertEnd, SAST_OFFSET_MIN);

  // 1. The device's history list for the period.
  const files = await listHistoryFiles({ deviceId, channelId, startTime: reqStart, endTime: reqEnd });
  for (const f of files) {
    if (!f?.fileUrl) continue;
    if (Number(f.channelId) !== Number(channelId)) continue;
    if (coversPeriod(f.startTime, f.endTime, neededStart, neededEnd)) {
      return {
        url: String(f.fileUrl),
        source: 'history-list',
        fileStart: f.startTime || null,
        fileEnd: f.endTime || null,
      };
    }
  }

  // 2. A completed upload task for the same device + channel.
  const tasks = await getUploadTasks();
  for (const t of tasks) {
    if (!t?.fileUrl || t.status !== 1) continue;
    if (String(t.deviceId) !== String(deviceId)) continue;
    if (Number(t.channelId) !== Number(channelId)) continue;
    if (coversPeriod(t.fileStartTime, t.fileEndTime, neededStart, neededEnd)) {
      return {
        url: String(t.fileUrl),
        source: 'upload-task',
        fileStart: t.fileStartTime || null,
        fileEnd: t.fileEndTime || null,
      };
    }
  }
  return null;
}

// Do the times cover what we need? Camera-local "YYYY-MM-DD HH:mm:ss"
// strings compare correctly as plain text.
function coversPeriod(fileStart, fileEnd, needStart, needEnd) {
  if (!fileStart || !fileEnd) return false;
  return fileStart <= needEnd && fileEnd >= needStart;
}

// Ask the camera to upload that exact period (historicalUpload).
async function triggerUpload({ deviceId, channelId, startTime, endTime }) {
  const res = await apiClient.makeRequest(
    '/video/history/upload',
    { deviceId, channelId: Number(channelId), startTime, endTime },
    15000
  ).catch((err) => ({ code: -1, msg: err.message }));
  if (res.code !== 0 || !res.data) {
    return { taskId: null, error: res.msg || 'Upload task could not be created' };
  }
  return { taskId: String(res.data), error: null };
}

// ── Storage ───────────────────────────────────────────────────────────────
// One row per alert + channel. The replay is stored first, the uploaded file
// upgrades the same row when it arrives.
async function upsertFootageRow(row) {
  await db.query(
    `INSERT INTO alert_footage
       (alert_id, alert_group_id, device_id, fleet_number, registration, channel_id,
        alarm_type, video_url, kind, window_start, window_end, status, error, requested_by,
        replay_url, replay_state, replay_error, file_url, file_state, file_error,
        file_start, file_end, upload_task_id, upload_period_start, upload_period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (alert_id, channel_id) DO UPDATE SET
       alert_group_id = COALESCE(EXCLUDED.alert_group_id, alert_footage.alert_group_id),
       device_id = COALESCE(EXCLUDED.device_id, alert_footage.device_id),
       fleet_number = COALESCE(EXCLUDED.fleet_number, alert_footage.fleet_number),
       registration = COALESCE(EXCLUDED.registration, alert_footage.registration),
       alarm_type = COALESCE(EXCLUDED.alarm_type, alert_footage.alarm_type),
       video_url = COALESCE(EXCLUDED.video_url, alert_footage.video_url),
       kind = COALESCE(EXCLUDED.kind, alert_footage.kind),
       window_start = COALESCE(EXCLUDED.window_start, alert_footage.window_start),
       window_end = COALESCE(EXCLUDED.window_end, alert_footage.window_end),
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       replay_url = COALESCE(EXCLUDED.replay_url, alert_footage.replay_url),
       replay_state = EXCLUDED.replay_state,
       replay_error = EXCLUDED.replay_error,
       file_url = COALESCE(EXCLUDED.file_url, alert_footage.file_url),
       file_state = EXCLUDED.file_state,
       file_error = EXCLUDED.file_error,
       file_start = COALESCE(EXCLUDED.file_start, alert_footage.file_start),
       file_end = COALESCE(EXCLUDED.file_end, alert_footage.file_end),
       upload_task_id = COALESCE(EXCLUDED.upload_task_id, alert_footage.upload_task_id),
       upload_period_start = COALESCE(EXCLUDED.upload_period_start, alert_footage.upload_period_start),
       upload_period_end = COALESCE(EXCLUDED.upload_period_end, alert_footage.upload_period_end),
       updated_at = NOW()
     RETURNING id`,
    [
      row.alertId, row.alertGroupId, row.deviceId, row.fleetNumber, row.registration,
      row.channelId, row.alarmType, row.videoUrl, row.kind, row.windowStart, row.windowEnd,
      row.status, row.error, 'system',
      row.replayUrl, row.replayState, row.replayError,
      row.fileUrl, row.fileState, row.fileError,
      row.fileStart, row.fileEnd, row.uploadTaskId,
      row.uploadPeriodStart, row.uploadPeriodEnd,
    ]
  ).catch((err) => {
    console.error('[FOOTAGE] could not store the footage row:', err.message);
  });
}

// The resolved primary link: the durable file first, the one-shot stream next.
function resolvePrimary(row) {
  if (row.fileUrl) return { videoUrl: row.fileUrl, kind: 'file' };
  if (row.replayUrl) return { videoUrl: row.replayUrl, kind: 'replay' };
  return { videoUrl: null, kind: row.kind || 'replay' };
}

function overallStatus(row) {
  if (row.videoUrl) return 'READY';
  if (row.replayState === 'FAILED' && row.fileState === 'FAILED') return 'FAILED';
  return 'REQUESTED';
}

// The stored row for one alert + channel.
async function loadRow(alertId, channelId) {
  const { rows } = await db.query(
    'SELECT * FROM alert_footage WHERE alert_id = $1 AND channel_id = $2 LIMIT 1',
    [alertId, channelId]
  );
  return rows[0] || null;
}

// ── The watcher ───────────────────────────────────────────────────────────
// The camera needs a few minutes to upload a one minute clip. The watcher
// checks the pending uploads every 20 seconds and stores the link the moment
// the file is there, so the footage link appears on its own.
const WATCHER_INTERVAL_MS = 20 * 1000;
let watcherTimer = null;
let watcherRunning = false;

async function storeFileOnRow(row, file) {
  const offsetMinutes = file.offsetMinutes ?? SAST_OFFSET_MIN;
  const fileStart = file.start ? cameraStampToIso(file.start, offsetMinutes) : null;
  const fileEnd = file.end ? cameraStampToIso(file.end, offsetMinutes) : null;
  const primary = resolvePrimary({ fileUrl: file.url });
  await db.query(
    `UPDATE alert_footage SET
        file_url = $2,
        file_state = 'READY',
        file_error = NULL,
        file_start = COALESCE($3, file_start),
        file_end = COALESCE($4, file_end),
        video_url = COALESCE($2, video_url),
        kind = CASE WHEN $2 IS NOT NULL THEN 'file' ELSE kind END,
        status = CASE WHEN $2 IS NOT NULL THEN 'READY' ELSE status END,
        error = CASE WHEN $2 IS NOT NULL THEN NULL ELSE error END,
        updated_at = NOW()
      WHERE id = $1`,
    [row.id, file.url, fileStart, fileEnd]
  ).catch((err) => console.error('[FOOTAGE] could not store the uploaded file:', err.message));
  console.log(
    `[FOOTAGE] ${row.fleet_number || row.registration || row.device_id} CH${row.channel_id}: ` +
    `the camera uploaded the clip (${file.start || '?'} -> ${file.end || '?'})`
  );
}

// One pass over every pending upload.
async function watchPendingUploads(limit = 40) {
  if (watcherRunning) return;
  watcherRunning = true;
  try {
    const { rows } = await db.query(
      `SELECT id, alert_id, alert_group_id, device_id, fleet_number, registration, channel_id,
              alarm_type, window_start, window_end, upload_task_id
         FROM alert_footage
        WHERE file_state = 'REQUESTED' AND upload_task_id IS NOT NULL
        ORDER BY updated_at ASC
        LIMIT $1`,
      [limit]
    );
    for (const row of rows) {
      const task = await getUploadTask(row.upload_task_id).catch(() => null);
      if (!task) continue;
      if (task.status === 1 && task.fileUrl) {
        await storeFileOnRow(row, {
          url: String(task.fileUrl),
          start: task.fileStartTime,
          end: task.fileEndTime,
        });
      }
    }
  } catch (err) {
    console.error('[FOOTAGE] watcher pass failed:', err.message);
  } finally {
    watcherRunning = false;
  }
}

function startWatcher() {
  if (watcherTimer) return;
  watcherTimer = setInterval(() => {
    watchPendingUploads().catch(() => {});
  }, WATCHER_INTERVAL_MS);
  if (typeof watcherTimer.unref === 'function') watcherTimer.unref();
  watchPendingUploads().catch(() => {});
  console.log(`[FOOTAGE] watcher started (every ${WATCHER_INTERVAL_MS / 1000}s)`);
}

function stopWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = null;
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

  const { when, alertStart, alertEnd, uploadStart, uploadEnd } = resolvePeriod(alertTime);
  const offsetMinutes = camera.offsetMinutes ?? SAST_OFFSET_MIN;
  const alertStartTime = formatCameraTime(alertStart, offsetMinutes);
  const alertEndTime = formatCameraTime(alertEnd, offsetMinutes);
  const uploadStartTime = formatCameraTime(uploadStart, offsetMinutes);
  const uploadEndTime = formatCameraTime(uploadEnd, offsetMinutes);

  const base = {
    alertId,
    alertGroupId,
    deviceId: camera.deviceId,
    fleetNumber,
    registration,
    alarmType,
    windowStart: alertStart.toISOString(),
    windowEnd: alertEnd.toISOString(),
    uploadPeriodStart: uploadStart.toISOString(),
    uploadPeriodEnd: uploadEnd.toISOString(),
  };

  const results = await Promise.all(
    camera.channels.map(async (channelId) => {
      // A) The live replay — ready in seconds, but one-shot.
      const replay = await requestReplay({
        deviceId: camera.deviceId,
        channelId,
        startTime: alertStartTime,
        endTime: alertEndTime,
      });

      // B) The durable file: only ask the camera to upload it if it is not
      //    already there for that period.
      const existing = await findAlreadyUploaded({
        deviceId: camera.deviceId,
        channelId,
        alertStart,
        alertEnd,
        uploadStart,
        uploadEnd,
      });

      let fileUrl = existing?.url || null;
      let fileState = existing ? 'READY' : 'PENDING';
      let fileError = null;
      let fileStart = existing?.fileStart ? cameraStampToIso(existing.fileStart, offsetMinutes) : null;
      let fileEnd = existing?.fileEnd ? cameraStampToIso(existing.fileEnd, offsetMinutes) : null;
      let uploadTaskId = null;

      if (!fileUrl) {
        const upload = await triggerUpload({
          deviceId: camera.deviceId,
          channelId,
          startTime: uploadStartTime,
          endTime: uploadEndTime,
        });
        if (upload.taskId) {
          uploadTaskId = upload.taskId;
          fileState = 'REQUESTED';
        } else {
          fileState = 'FAILED';
          fileError = String(upload.error || 'upload could not be requested').slice(0, 300);
        }
      }

      const row = {
        ...base,
        channelId,
        replayUrl: replay.url,
        replayState: replay.url ? 'READY' : 'FAILED',
        replayError: replay.url ? null : String(replay.error || 'no replay').slice(0, 300),
        fileUrl,
        fileState,
        fileError,
        fileStart,
        fileEnd,
        uploadTaskId,
      };
      const primary = resolvePrimary(row);
      row.videoUrl = primary.videoUrl;
      row.kind = primary.kind;
      row.status = overallStatus(row);
      row.error = row.status === 'FAILED' ? (row.replayError || row.fileError) : null;

      await upsertFootageRow(row);
      return row;
    })
  );

  // Fire and forget: the camera uploads the clip in its own time and the
  // watcher stores the link as soon as the file is there. Nothing waits.
  const ready = results.filter((r) => r.status === 'READY').length;
  const files = results.filter((r) => r.fileUrl).length;
  console.log(
    `[FOOTAGE] ${fleetNumber || registration}: ${ready}/${results.length} channel(s) with a link ` +
    `(${files} uploaded file(s)) for "${alarmType}" — the camera is uploading now`
  );
  return {
    captured: ready,
    channels: results.length,
    files,
    deviceId: camera.deviceId,
    rows: results,
  };
}

/**
 * Follow up on the footage of an alert: poll the upload task, and ask again
 * when the camera never uploaded it (it may have been powered off).
 */
async function refreshIncidentFootage(payload = {}) {
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
    return { skipped: true, reason: `no footage for "${alarmType}"` };
  }

  // The device we already used when the alert fired — no lookup needed.
  let camera = null;
  if (deviceId) {
    camera = { deviceId: String(deviceId), channels: [1, 2], offsetMinutes: SAST_OFFSET_MIN };
  } else {
    camera = await resolveVehicleCamera({ fleetNumber, registration, deviceId: null });
  }
  if (!camera || !camera.deviceId) {
    return { skipped: true, reason: 'no camera device' };
  }

  const { when, alertStart, alertEnd, uploadStart, uploadEnd } = resolvePeriod(alertTime);
  const offsetMinutes = camera.offsetMinutes ?? SAST_OFFSET_MIN;
  const uploadStartTime = formatCameraTime(uploadStart, offsetMinutes);
  const uploadEndTime = formatCameraTime(uploadEnd, offsetMinutes);

  const base = {
    alertId,
    alertGroupId,
    deviceId: camera.deviceId,
    fleetNumber,
    registration,
    alarmType,
    windowStart: alertStart.toISOString(),
    windowEnd: alertEnd.toISOString(),
    uploadPeriodStart: uploadStart.toISOString(),
    uploadPeriodEnd: uploadEnd.toISOString(),
  };

  const touched = await Promise.all(
    camera.channels.map(async (channelId) => {
      const stored = await loadRow(alertId, channelId);
      if (stored?.file_url) return null; // already have the durable file

      // 1. Did the upload task we started finish?
      let fileUrl = null;
      let fileStart = null;
      let fileEnd = null;
      let fileState = 'PENDING';
      let fileError = null;
      let uploadTaskId = stored?.upload_task_id || null;

      if (uploadTaskId) {
        const task = await getUploadTask(uploadTaskId).catch(() => null);
        if (task && task.status === 1 && task.fileUrl) {
          fileUrl = String(task.fileUrl);
          fileStart = task.fileStartTime ? cameraStampToIso(task.fileStartTime, offsetMinutes) : null;
          fileEnd = task.fileEndTime ? cameraStampToIso(task.fileEndTime, offsetMinutes) : null;
          fileState = 'READY';
        } else if (task && task.status === 2) {
          // Status 2 while the bytes are climbing = the camera is uploading
          // right now (a one minute clip takes a few minutes). A task that
          // has not moved at all for a while never started (the camera was
          // off) — that one we ask again.
          const uploaded = Number(task.fileUploadSize || 0);
          const createdIso = task.createTime ? cameraStampToIso(task.createTime, offsetMinutes) : null;
          const createdMs = createdIso ? Date.parse(createdIso) : NaN;
          const ageMin = Number.isNaN(createdMs) ? 999 : (Date.now() - createdMs) / 60000;
          if (uploaded > 0 || ageMin < STUCK_AFTER_MIN) {
            fileState = 'REQUESTED';
          } else {
            fileState = 'FAILED';
            fileError = 'The camera did not upload the footage (it was probably powered off)';
          }
        } else {
          fileState = 'REQUESTED';
        }
      }

      // 2. Not there yet: does the footage exist by now?
      if (!fileUrl) {
        const existing = await findAlreadyUploaded({
          deviceId: camera.deviceId,
          channelId,
          alertStart,
          alertEnd,
          uploadStart,
          uploadEnd,
        });
        if (existing) {
          fileUrl = existing.url;
          fileStart = existing.fileStart ? cameraStampToIso(existing.fileStart, offsetMinutes) : null;
          fileEnd = existing.fileEnd ? cameraStampToIso(existing.fileEnd, offsetMinutes) : null;
          fileState = 'READY';
          fileError = null;
          uploadTaskId = null;
        }
      }

      // 3. Still nothing: request the upload again.
      if (!fileUrl && fileState !== 'REQUESTED') {
        const upload = await triggerUpload({
          deviceId: camera.deviceId,
          channelId,
          startTime: uploadStartTime,
          endTime: uploadEndTime,
        });
        if (upload.taskId) {
          uploadTaskId = upload.taskId;
          fileState = 'REQUESTED';
          fileError = null;
        } else {
          fileState = 'FAILED';
          fileError = String(upload.error || 'upload could not be requested').slice(0, 300);
        }
      }

      const row = {
        ...base,
        channelId,
        replayUrl: stored?.replay_url || null,
        replayState: stored?.replay_state || 'FAILED',
        replayError: stored?.replay_error || null,
        fileUrl,
        fileState,
        fileError,
        fileStart,
        fileEnd,
        uploadTaskId,
      };
      const primary = resolvePrimary(row);
      row.videoUrl = primary.videoUrl;
      row.kind = primary.kind;
      row.status = overallStatus(row);
      row.error = row.status === 'FAILED' ? (row.replayError || row.fileError) : null;
      await upsertFootageRow(row);
      return row;
    })
  );

  const rows = touched.filter(Boolean);
  return { channels: rows.length, rows };
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
            alarm_type, video_url, kind, window_start, window_end, status, error, created_at,
            replay_url, replay_state, replay_error, file_url, file_state, file_error,
            file_start, file_end, upload_task_id, upload_period_start, upload_period_end
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
            count(*) FILTER (WHERE file_url IS NOT NULL)::int AS files,
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
  watchPendingUploads,
  startWatcher,
  stopWatcher,
  refreshIncidentFootage,
  listFootage,
  listFootageDevices,
  isFootageAlarmType,
  resolvePeriod,
  FOOTAGE_ALARM_TYPES,
};
