const apiClient = require('../helpers/apiClient');
const db = require('../db');
const { getVideoSeverityMap, getVideoNameMap } = require('../db/alert_definitions');
const { resolveFleetNumber, findVehicleCostCenterId } = require('./costCenterLookup');
const { resolveBaseSeverity, escalateSeverity } = require('../helpers/transform');

let syncState = {
  isRunning: false,
  lastSyncTime: null,
  lastSyncDuration: null,
  totalAlertsSynced: 0,
  totalMediaSynced: 0,
  lastError: null,
  syncInterval: null,
};

let wsBroadcast = null;
function setWsBroadcast(fn) { wsBroadcast = fn; }

const ALERT_TYPE_LIST = [
  'fatigueWarn', 'fatigueAlarm', 'handheldPhoneCall', 'seatBelt',
  'laneShift', 'closeProximity', 'bang', 'hardBraking',
  'driverNotDetected', 'forwardCollisionWarning', 'pedestrianBang',
  'overtime', 'speed', 'powerCut', 'occlusion', 'sos',
];

const VIDEO_MANDATORY_TYPES = new Set([
  'fatigueWarn', 'fatigueAlarm', 'bang', 'hardBraking',
  'forwardCollisionWarning', 'pedestrianBang', 'closeProximity',
]);

async function getAllDeviceIds() {
  const allDevices = [];
  let pageIndex = 1;
  let hasMore = true;
  while (hasMore) {
    let response;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await apiClient.makeRequest('/device/page', {
          pageIndex, pageSize: 100, subsumption: true,
        });
        if (response.code === 63001) {
          await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        console.error(`[SYNC] /device/page failed: ${err.message}`);
        return allDevices;
      }
    }
    if (response.code === 0 && response.data.records.length > 0) {
      allDevices.push(...response.data.records.map(d => d.id));
      pageIndex++;
      hasMore = response.data.records.length === 100;
    } else {
      hasMore = false;
    }
    if (hasMore) await sleep(200);
  }
  return allDevices;
}

async function fetchAlarmsPageWithRetry({ deviceIds, alarmType, startTime, endTime, pageIndex = 1, pageSize = 50 }) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await apiClient.makeRequest('/alarm/alarmPage', {
        pageSize,
        pageIndex,
        deviceIds,
        alarmType: alarmType || ALERT_TYPE_LIST.join(','),
        startTime,
        endTime,
      });

      if (response.code === 63001) {
        const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`[SYNC] Rate limited (63001) on alarmPage page ${pageIndex}, retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      return response;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`[SYNC] alarmPage page ${pageIndex} error (${err.message}), retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      console.error(`[SYNC] alarmPage page ${pageIndex} failed after ${MAX_RETRIES} retries: ${err.message}`);
      return { code: -1, data: null, msg: err.message };
    }
  }
  return { code: -1, data: null, msg: 'Max retries exceeded' };
}

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const MEDIA_CONCURRENCY = 5;
const BATCH_DELAY_MS = 1500;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchMediaForAlarm(alarmId) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await apiClient.makeRequest('/alarm/file/id', { alarmId });

      if (response.code === 63001) {
        const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`[SYNC] Rate limited (63001) alarm ${alarmId}, retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (response.code === 0 && Array.isArray(response.data)) {
        return response.data;
      }
      return [];
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return [];
    }
  }
  return [];
}

async function fetchMediaForAlerts(records, alarmTypeMap) {
  let mediaCount = 0;
  const total = records.length;

  for (let i = 0; i < total; i += MEDIA_CONCURRENCY) {
    const batch = records.slice(i, i + MEDIA_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (record) => {
        const alertId = record.id || record.alert_id;
        const alarmType = record.alarmType || record.alarm_type;
        const files = await fetchMediaForAlarm(alertId);
        return { alertId, alarmType, files, record };
      })
    );

    for (const { alertId, alarmType, files, record } of results) {
      if (files.length > 0) {
        const existingMedia = await db.batchMediaExists(files.map(f => ({ alertId, fileUrl: f.fileUrl })));
        const newFiles = files.filter(f => !existingMedia[`${alertId}::${f.fileUrl}`]);
        if (newFiles.length > 0) {
          await db.batchInsertMedia(newFiles.map(f => ({
            alertId,
            fileUrl: f.fileUrl,
            fileType: f.fileType,
            fileSize: f.fileSize,
            deviceName: f.deviceName,
            alarmType,
          })));
          mediaCount += newFiles.length;
        }
      }

      const hasVideo = files.some(f => f.fileType === '02');
      if (!hasVideo) {
        const ts = record.alarmTs || record.alarm_ts;
        const rawEnd = record.alarmTsEnd || record.alarm_ts_end || ts;
        const devId = record.deviceId || record.device_id;
        const devName = record.deviceName || record.device_name || '';
        if (ts && devId) {
          const tsDate = new Date(ts);
          const rawEndDate = new Date(rawEnd);
          const minEnd = new Date(tsDate.getTime() + 15 * 1000);
          const tsEnd = rawEndDate > minEnd ? rawEndDate : minEnd;
          const replayUrl = await fetchReplayUrl(devId, 1, ts, tsEnd.toISOString().replace('T', ' ').slice(0, 19));
          if (replayUrl) {
            await db.batchInsertMedia([{
              alertId,
              fileUrl: replayUrl,
              fileType: '02',
              fileSize: 0,
              deviceName: devName,
              alarmType,
            }]);
            mediaCount++;
          }
        }
      }
    }

    const processed = Math.min(i + MEDIA_CONCURRENCY, total);
    console.log(`[SYNC] Media ${processed}/${total}: ${mediaCount} files so far`);

    if (i + MEDIA_CONCURRENCY < total) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return mediaCount;
}

async function fetchMediaOnDemand(alertRecord) {
  const alertId = alertRecord.id || alertRecord.alert_id;
  const alarmType = alertRecord.alarmType || alertRecord.alarm_type;
  const ts = alertRecord.alarmTs || alertRecord.alarm_ts;
  const rawEnd = alertRecord.alarmTsEnd || alertRecord.alarm_ts_end || ts;
  const devId = alertRecord.deviceId || alertRecord.device_id;
  const devName = alertRecord.deviceName || alertRecord.device_name || '';

  const files = await fetchMediaForAlarm(alertId);
  let storedCount = 0;

  if (files.length > 0) {
    const existingMedia = await db.batchMediaExists(files.map(f => ({ alertId, fileUrl: f.fileUrl })));
    const newFiles = files.filter(f => !existingMedia[`${alertId}::${f.fileUrl}`]);
    if (newFiles.length > 0) {
      await db.batchInsertMedia(newFiles.map(f => ({
        alertId,
        fileUrl: f.fileUrl,
        fileType: f.fileType,
        fileSize: f.fileSize,
        deviceName: f.deviceName,
        alarmType,
      })));
      storedCount += newFiles.length;
    }
  }

  const hasVideo = files.some(f => f.fileType === '02');
  if (!hasVideo && ts && devId) {
    const tsDate = new Date(ts);
    const rawEndDate = new Date(rawEnd);
    const minEnd = new Date(tsDate.getTime() + 15 * 1000);
    const tsEnd = rawEndDate > minEnd ? rawEndDate : minEnd;
    const replayUrl = await fetchReplayUrl(devId, 1, ts, tsEnd.toISOString().replace('T', ' ').slice(0, 19));
    if (replayUrl) {
      await db.batchInsertMedia([{
        alertId,
        fileUrl: replayUrl,
        fileType: '02',
        fileSize: 0,
        deviceName: devName,
        alarmType,
      }]);
      storedCount++;
    }
  }

  if (storedCount > 0) {
    console.log(`[MEDIA] On-demand: ${storedCount} files for alert ${alertId}`);
  }
  return db.getMediaForAlert(alertId);
}

async function fetchReplayUrl(deviceId, channelId, startTime, endTime) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await apiClient.makeRequest('/video/history/replay', {
        deviceId,
        channelId,
        playbackType: 0,
        fastForwardOrBackward: 0,
        startTime: typeof startTime === 'string' ? startTime : new Date(startTime).toISOString().replace('T', ' ').slice(0, 19),
        endTime: typeof endTime === 'string' ? endTime : new Date(endTime).toISOString().replace('T', ' ').slice(0, 19),
      });

      if (response.code === 63001) {
        const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(wait);
        continue;
      }

      if (response.code === 0 && response.data) return response.data;
      return null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function gateVideoRecordsByCostCenter(records) {
  const byDevice = new Map();
  for (const r of records) {
    const did = r.deviceId || '';
    if (!byDevice.has(did)) byDevice.set(did, []);
    byDevice.get(did).push(r);
  }

  const globalVideoMap = await getVideoSeverityMap([]).catch(() => ({}));
  const ccVideoMaps = {};
  const kept = [];
  let gatedOut = 0;

  await Promise.all([...byDevice.entries()].map(async ([did, recs]) => {
    let allowed = globalVideoMap;
    try {
      const fleet = await resolveFleetNumber({ deviceId: did, vehicleRegistration: recs[0]?.deviceName }).catch(() => null);
      const ccId = fleet ? await findVehicleCostCenterId(fleet).catch(() => null) : null;
      if (ccId) {
        if (!ccVideoMaps[ccId]) ccVideoMaps[ccId] = await getVideoSeverityMap([ccId]).catch(() => ({}));
        allowed = ccVideoMaps[ccId];
      }
    } catch { /* fall back to global map */ }
    for (const r of recs) {
      if (allowed[String(r.alarmType || '').toLowerCase()]) kept.push(r);
      else gatedOut++;
    }
  }));

  if (gatedOut > 0) {
    console.log(`[SYNC] Gated out ${gatedOut} video alert(s) not in device cost-center set`);
  }
  return kept;
}

/**
 * Rewrite video `alarmType` from the camera signal code (e.g. "occlusion") to
 * its alert_definitions name (e.g. "Camera Occlusion"). Runs AFTER the CC gate,
 * which needs the raw code to decide.
 */
async function normalizeVideoAlarmTypes(records) {
  if (!records || records.length === 0) return records;
  let nameMap;
  try {
    nameMap = await getVideoNameMap();
  } catch (_) {
    return records; // no map → keep raw codes rather than drop alerts
  }
  for (const r of records) {
    const name = nameMap[String(r.alarmType || '').toLowerCase()];
    if (name) r.alarmType = name;
  }
  return records;
}

async function syncAlerts(deviceIds, startTime, endTime) {
  let pageIndex = 1;
  let hasMore = true;
  const allNewRecords = [];
  let emptyPageCount = 0;

  while (hasMore) {
    const response = await fetchAlarmsPageWithRetry({
      deviceIds,
      startTime,
      endTime,
      pageIndex,
      pageSize: 100,
    });

    if (response.code !== 0 || !response.data?.records?.length) {
      hasMore = false;
      break;
    }

    const records = response.data.records;

    const ids = records.map(r => r.id);
    const existsMap = await db.batchAlertExists(ids);
    let newRecords = records.filter(r => !existsMap[r.id]);

    // STRICT CC GATE: only store video alerts whose signal code is in the
    // device's cost-center set (CC vehicles), or in the global set (CC-less
    // vehicles). Alerts not configured for that cost center are dropped here
    // and never reach alerts / alert_groups.
    if (newRecords.length > 0) {
      try {
        newRecords = await gateVideoRecordsByCostCenter(newRecords);
      } catch (gateErr) {
        console.error('[SYNC] CC gate error (storing unfiltered):', gateErr.message);
      }
      // Store the alert_definitions NAME, not the raw camera signal code, so
      // alerts/alert_groups match what Alert Config lists (and what the
      // telematics path already stores). Unknown codes pass through unchanged.
      newRecords = await normalizeVideoAlarmTypes(newRecords);
    }

    if (newRecords.length > 0) {
      emptyPageCount = 0;
      await db.batchUpsertAlerts(newRecords.map(r => ({
        id: r.id,
        deviceId: r.deviceId,
        deviceName: r.deviceName,
        alarmType: r.alarmType,
        alarmTs: r.alarmTs ? new Date(r.alarmTs) : null,
        alarmTsEnd: r.alarmTsEnd ? new Date(r.alarmTsEnd) : null,
        lat: r.lat,
        lon: r.lon,
        alarmText: r.alarmText,
        serialNo: r.serialNo,
        fenceId: r.fenceId,
        alarmExtension: r.alarmExtension ? JSON.stringify(r.alarmExtension) : null,
      })));

      // Push new video alerts over WS as fast as possible so the frontend
      // receives them without waiting for its own polling cycle.
      // Groups are upserted first so severity can be escalated by event count.
      const groupMap = {};
      for (const r of newRecords) {
        const key = `${r.deviceId}:${r.alarmType}`.toLowerCase();
        if (!groupMap[key] || new Date(r.alarmTs || 0) > new Date(groupMap[key].alarmTs || 0)) {
          groupMap[key] = r;
        }
      }
      const groupEntries = Object.values(groupMap).map(r => ({
        deviceId: r.deviceId,
        deviceName: r.deviceName,
        alarmType: r.alarmType,
        alarmText: r.alarmText,
        alertId: r.id,
        alarmTs: r.alarmTs ? new Date(r.alarmTs) : null,
        lat: r.lat,
        lon: r.lon,
      }));
      let severityMap = null;
      try {
        severityMap = await getVideoSeverityMap([]);
      } catch (_) { /* fall back to PRIORITY_MAP */ }
      const groupSeverityByKey = {};
      if (groupEntries.length > 0) {
        try {
          const groupRows = await db.batchUpsertAlertGroups(groupEntries);
          for (const row of groupRows || []) {
            if (!row?.group_key) continue;
            const count = Number(row.count) || 1;
            const base = resolveBaseSeverity(row.alarm_type, severityMap);
            const escalated = escalateSeverity(base, count);
            groupSeverityByKey[row.group_key] = {
              base,
              escalated,
              count,
              escalatedFlag: escalated !== base,
              groupId: row.id != null ? String(row.id) : '',
            };
          }
        } catch (_) { /* group upsert failure must not block WS */ }
      }

      if (wsBroadcast) {
        for (const r of newRecords) {
          try {
            const alarmTsIso = r.alarmTs ? new Date(r.alarmTs).toISOString() : new Date().toISOString();
            const gkey = `${r.deviceId}:${r.alarmType}`.toLowerCase();
            const gsev = groupSeverityByKey[gkey];
            const base = gsev?.base || resolveBaseSeverity(r.alarmType, severityMap);
            const escalated = gsev?.escalated || escalateSeverity(base, gsev?.count || 1);
            // Resolve targets alert_groups.id only — Mettax alarm id stays on last_alert_id.
            const groupId = gsev?.groupId || '';
            if (!groupId) continue;
            wsBroadcast('new-alert', {
              alert: {
                id: groupId,
                alert_id: groupId,
                last_alert_id: r.id,
                alarmId: r.id,
                alarm_id: r.id,
                device_id: r.deviceId,
                deviceId: r.deviceId,
                vehicleId: r.deviceId,
                device_name: r.deviceName,
                deviceName: r.deviceName,
                alert_type: r.alarmType,
                alarm_type: r.alarmType,
                type: r.alarmType,
                title: r.alarmType,
                alarmText: r.alarmText,
                timestamp: alarmTsIso,
                alarmTs: alarmTsIso,
                last_occurrence: alarmTsIso,
                source_type: 'video',
                severity: escalated,
                priority: escalated,
                base_severity: base,
                escalated: gsev?.escalatedFlag || escalated !== base,
                status: 'new',
                resolved: false,
                count: gsev?.count || 1,
                group_key: gkey,
                lat: r.lat,
                lon: r.lon,
              },
            });
          } catch (_) { /* skip */ }
        }
      }

      allNewRecords.push(...newRecords);
    } else {
      emptyPageCount++;
    }

    console.log(`[SYNC] Page ${pageIndex}: ${newRecords.length} new alerts`);
    hasMore = records.length === 100 && (response.data.total > pageIndex * 100);
    pageIndex++;
    if (hasMore) await sleep(100);

    if (emptyPageCount >= 5) {
      console.log(`[SYNC] ${emptyPageCount} consecutive empty pages — stopping pagination`);
      break;
    }
  }

  // Media fetching disabled during auto-sync — frontend no longer uses pre-fetched media.
  // On-demand media fetch is still available via fetchMediaOnDemand().
  let mediaCount = 0;
  if (allNewRecords.length > 0) {
    console.log(`[SYNC] ${allNewRecords.length} new alerts synced (media fetch disabled)`);
  }

  return { newCount: allNewRecords.length, mediaCount };
}

async function runSync() {
  if (syncState.isRunning) {
    console.log('[SYNC] Already running, skipping');
    return;
  }

  const startTime = Date.now();
  syncState.isRunning = true;

  try {
    console.log('[SYNC] Starting alert sync...');

    const deviceIds = await getAllDeviceIds();
    if (deviceIds.length === 0) {
      console.log('[SYNC] No devices found, skipping');
      syncState.isRunning = false;
      return;
    }

    const idsStr = deviceIds.join(',');
    const now = new Date();
    const defaultEnd = now.toISOString().replace('T', ' ').slice(0, 19);

    // High-water mark: resume from the last alert timestamp in the DB (minus a
    // 10-minute overlap to catch late-arriving / retried alerts), instead of a
    // sliding wall-clock window that can miss alerts entirely.
    let defaultStart;
    try {
      const hwmResult = await db.query(`SELECT MAX(alarm_ts) AS latest FROM alerts`);
      const latestTs = hwmResult.rows[0]?.latest;
      defaultStart = latestTs
        ? new Date(new Date(latestTs).getTime() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
        : new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`[SYNC] High-water mark: latest alarm_ts=${latestTs}, start=${defaultStart}`);
    } catch (hwmErr) {
      defaultStart = new Date(now.getTime() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    }

    syncState.lastSyncStart = defaultStart;
    const result = await syncAlerts(idsStr, defaultStart, defaultEnd);

    syncState.lastSyncTime = now.getTime();
    syncState.lastSyncDuration = Date.now() - startTime;
    syncState.totalAlertsSynced += result.newCount;
    syncState.totalMediaSynced += result.mediaCount;
    syncState.lastError = null;

    console.log(`[SYNC] Done: ${result.newCount} new alerts, ${result.mediaCount} media files (${syncState.lastSyncDuration}ms)`);
  } catch (err) {
    syncState.lastError = err.message;
    console.error(`[SYNC] Error: ${err.message}`);
  } finally {
    syncState.isRunning = false;
  }
}

async function refetchMissingMedia() {
  if (syncState.isRunning) {
    console.log('[SYNC] Sync in progress, cannot refetch media');
    return { refetched: 0 };
  }

  syncState.isRunning = true;
  const startTime = Date.now();
  let refetched = 0;

  try {
    console.log('[SYNC] Refetching media for alerts with no media...');
    const alertsWithoutMedia = await db.getAlertsWithoutMedia(100);
    if (alertsWithoutMedia.length === 0) {
      console.log('[SYNC] No alerts without media');
      return { refetched: 0, elapsed: 0 };
    }
    console.log(`[SYNC] Found ${alertsWithoutMedia.length} alerts without media`);

    console.log(`[SYNC] Fetching media for ${alertsWithoutMedia.length} alerts via /alarm/file/id...`);
    refetched = await fetchMediaForAlerts(alertsWithoutMedia, {});

    const elapsed = Date.now() - startTime;
    console.log(`[SYNC] Media refetch done: ${refetched} new files (${elapsed}ms)`);
    syncState.totalMediaSynced += refetched;
    return { refetched, elapsed };
  } catch (err) {
    console.error(`[SYNC] Media refetch error: ${err.message}`);
    return { refetched, error: err.message };
  } finally {
    syncState.isRunning = false;
  }
}

function getStatus() {
  const { syncInterval, ...rest } = syncState;
  return { ...rest };
}

async function startAutoSync(intervalMs = 30000) {
  await runSync();
  // Media refetch disabled — alerts are synced without constant media fetching.
  syncState.syncInterval = setInterval(async () => {
    await runSync();
  }, intervalMs);
  console.log(`[SYNC] Auto-sync every ${intervalMs / 1000}s (media fetch disabled)`);
}

function stopAutoSync() {
  if (syncState.syncInterval) {
    clearInterval(syncState.syncInterval);
    syncState.syncInterval = null;
  }
}

module.exports = {
  runSync,
  startAutoSync,
  stopAutoSync,
  getStatus,
  refetchMissingMedia,
  fetchMediaOnDemand,
  fetchReplayUrl,
  setWsBroadcast,
};
