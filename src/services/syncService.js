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

async function getAllDeviceIds() {
  const allDevices = [];
  let pageIndex = 1;
  let hasMore = true;
  while (hasMore) {
    const response = await apiClient.makeRequest('/device/page', {
      pageIndex, pageSize: 100, subsumption: true,
    });
    if (response.code === 0 && response.data.records.length > 0) {
      allDevices.push(...response.data.records.map(d => d.id));
      pageIndex++;
      hasMore = response.data.records.length === 100;
    } else {
      hasMore = false;
    }
  }
  return allDevices;
}

async function fetchAlarmsPage({ deviceIds, alarmType, startTime, endTime, pageIndex = 1, pageSize = 50 }) {
  const response = await apiClient.makeRequest('/alarm/alarmPage', {
    pageSize,
    pageIndex,
    deviceIds,
    alarmType: alarmType || ALERT_TYPE_LIST.join(','),
    startTime,
    endTime,
  });
  return response;
}

async function fetchMediaForAlarm(alarmId) {
  try {
    const response = await apiClient.makeRequest('/alarm/file/id', { alarmId });
    if (response.code === 0 && Array.isArray(response.data)) {
      return response.data;
    }
    return [];
  } catch (err) {
    return [];
  }
}

async function fetchMediaBatch(records) {
  const results = await Promise.all(
    records.map(async (record) => {
      const files = await fetchMediaForAlarm(record.id);
      return { alertId: record.id, files };
    })
  );
  return results;
}

async function syncAlerts(deviceIds, startTime, endTime) {
  let pageIndex = 1;
  let hasMore = true;
  let newCount = 0;
  let mediaCount = 0;

  while (hasMore) {
    const response = await fetchAlarmsPage({
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

    // Batch existence check — 1 query instead of N
    const ids = records.map(r => r.id);
    const existsMap = await db.batchAlertExists(ids);
    const newRecords = records.filter(r => !existsMap[r.id]);

    for (const record of newRecords) {
      newCount++;
    }

    const MEDIA_CONCURRENCY = 5;

    if (newRecords.length > 0) {
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

      const alarmTypeMap = {};
      for (const r of newRecords) { alarmTypeMap[r.id] = r.alarmType; }


      for (let i = 0; i < newRecords.length; i += MEDIA_CONCURRENCY) {
        const batch = newRecords.slice(i, i + MEDIA_CONCURRENCY);
        const batchResults = await fetchMediaBatch(batch);
        for (const { alertId, files } of batchResults) {
          if (files.length === 0) continue;
          const existingMedia = await db.batchMediaExists(files.map(f => ({ alertId, fileUrl: f.fileUrl })));
          const newFiles = files.filter(f => !existingMedia[`${alertId}::${f.fileUrl}`]);
          if (newFiles.length > 0) {
            await db.batchInsertMedia(newFiles.map(f => ({
              alertId,
              fileUrl: f.fileUrl,
              fileType: f.fileType,
              fileSize: f.fileSize,
              deviceName: f.deviceName,
              alarmType: alarmTypeMap[alertId],
            })));
            mediaCount += newFiles.length;
          }
        }
      }
    }

    if (newCount > 0) {
      console.log(`[SYNC] Page ${pageIndex}: ${newCount} new alerts, ${mediaCount} media files (batch ${MEDIA_CONCURRENCY})`);
    }

    hasMore = records.length === 100 && (response.data.total > pageIndex * 100);
    pageIndex++;
  }

  return { newCount, mediaCount };
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
      defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
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
  const CONCURRENCY = 5;

  try {
    console.log('[SYNC] Refetching media for alerts with no media...');
    const alertsWithoutMedia = await db.getAlertsWithoutMedia(200);
    console.log(`[SYNC] Found ${alertsWithoutMedia.length} alerts without media`);

    const alarmTypeMap = {};
    for (const a of alertsWithoutMedia) { alarmTypeMap[a.id] = a.alarm_type; }

    for (let i = 0; i < alertsWithoutMedia.length; i += CONCURRENCY) {
      const batch = alertsWithoutMedia.slice(i, i + CONCURRENCY);
      const batchResults = await fetchMediaBatch(batch);
      for (const { alertId, files } of batchResults) {
        if (files.length === 0) continue;
        const existingMedia = await db.batchMediaExists(files.map(f => ({ alertId, fileUrl: f.fileUrl })));
        const newFiles = files.filter(f => !existingMedia[`${alertId}::${f.fileUrl}`]);
        if (newFiles.length > 0) {
          await db.batchInsertMedia(newFiles.map(f => ({
            alertId,
            fileUrl: f.fileUrl,
            fileType: f.fileType,
            fileSize: f.fileSize,
            deviceName: f.deviceName,
            alarmType: alarmTypeMap[alertId],
          })));
          refetched += newFiles.length;
        }
      }
    }

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
  syncState.syncInterval = setInterval(runSync, intervalMs);
  console.log(`[SYNC] Auto-sync every ${intervalMs / 1000}s`);
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
};
