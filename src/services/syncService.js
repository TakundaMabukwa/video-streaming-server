const apiClient = require('../helpers/apiClient');
const db = require('../db');

let syncState = {
  isRunning: false,
  lastSyncTime: null,
  lastSyncDuration: null,
  totalAlertsSynced: 0,
  totalMediaSynced: 0,
  lastError: null,
  syncInterval: null,
};

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
    const newRecords = records.filter(r => !existsMap[r.id]);

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
      if (groupEntries.length > 0) {
        await db.batchUpsertAlertGroups(groupEntries);
      }

      allNewRecords.push(...newRecords);
    } else {
      emptyPageCount++;
    }

    console.log(`[SYNC] Page ${pageIndex}: ${newRecords.length} new alerts`);
    hasMore = records.length === 100 && (response.data.total > pageIndex * 100);
    pageIndex++;
    if (hasMore) await sleep(200);

    if (emptyPageCount >= 5) {
      console.log(`[SYNC] ${emptyPageCount} consecutive empty pages — stopping pagination`);
      break;
    }
  }

  let mediaCount = 0;
  if (allNewRecords.length > 0) {
    const groupMap = {};
    for (const r of allNewRecords) {
      const key = `${r.deviceId}:${r.alarmType}`.toLowerCase();
      if (!groupMap[key] || new Date(r.alarmTs || 0) > new Date(groupMap[key].alarmTs || 0)) {
        groupMap[key] = r;
      }
    }
    const latestPerGroup = Object.values(groupMap);
    console.log(`[SYNC] ${allNewRecords.length} new alerts across ${latestPerGroup.length} groups — fetching media per group`);
    mediaCount = await fetchMediaForAlerts(latestPerGroup, {});
    console.log(`[SYNC] Media fetch done: ${mediaCount} files`);
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

    let defaultStart;
    if (syncState.lastSyncTime) {
      defaultStart = new Date(syncState.lastSyncTime - 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    } else {
      defaultStart = new Date(now.getTime() - 6 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    }

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

async function startAutoSync(intervalMs = 60000) {
  await runSync();
  await refetchMissingMedia();
  syncState.syncInterval = setInterval(async () => {
    await runSync();
    await refetchMissingMedia();
  }, intervalMs);
  console.log(`[SYNC] Auto-sync every ${intervalMs / 1000}s with media refetch`);
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
};
