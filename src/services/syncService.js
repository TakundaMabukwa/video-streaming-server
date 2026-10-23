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
  const ts = alertRecord.alarmTs || alertRecord.alarm_ts;
  const rawEnd = alertRecord.alarmTsEnd || alertRecord.alarm_ts_end || ts;
  const devId = alertRecord.deviceId || alertRecord.device_id;
  const devName = alertRecord.deviceName || alertRecord.device_name || '';

  // Always live-fetch from skycamx — alert_media is never read or written.
  let files = await fetchMediaForAlarm(alertId);

  // No video in the alarm files: pull a fresh replay URL from skycamx.
  const hasVideo = files.some((f) => f.fileType === '02');
  if (!hasVideo && ts && devId) {
    const tsDate = new Date(ts);
    const rawEndDate = new Date(rawEnd);
    const minEnd = new Date(tsDate.getTime() + 15 * 1000);
    const tsEnd = rawEndDate > minEnd ? rawEndDate : minEnd;
    const replayUrl = await fetchReplayUrl(devId, 1, ts, tsEnd.toISOString().replace('T', ' ').slice(0, 19));
    if (replayUrl) {
      files = [...files, { fileUrl: replayUrl, fileType: '02', fileSize: 0 }];
    }
  }

  // Normalize skycamx camelCase rows to the snake_case shape the controllers expect.
  return files.map((f, i) => ({
    id: f.id || `skycam-${i}`,
    alert_id: alertId,
    file_url: f.fileUrl || f.file_url || '',
    file_type: f.fileType || f.file_type || '',
    file_size: f.fileSize || f.file_size || 0,
    device_name: f.deviceName || f.device_name || devName,
    created_at: f.createdAt || f.created_at || null,
    alarm_time: f.alarmTime || f.alarm_time || null,
  }));
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
      let videoSeverityMap = null;
      try {
        videoSeverityMap = await getVideoSeverityMap([]);
      } catch { videoSeverityMap = null; }
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
        speed: r.speed ?? null,
        severity: resolveBaseSeverity(r.alarmType, videoSeverityMap),
      })));

      // Combo gate: a member of an enabled AND-combination group is held back
      // here. The detection row is already stored above (so its media and
      // footage work exactly as before), but it gets NO alert_groups row until
      // every member has fired for the device inside the combo's window.
      // Anything not claimed by a combo keeps the normal batch group upsert.
      const comboRaisedGroups = [];
      if (newRecords.length > 0) {
        try {
          const alertCombos = require('./alertCombos');
          const combosActive = await alertCombos.listEnabledCombos(null).catch(() => []);
          if (combosActive.length > 0) {
            const ccByDevice = new Map();
            const comboHeld = new Set();
            for (const r of newRecords) {
              const did = String(r.deviceId || '');
              if (!ccByDevice.has(did)) {
                let ccId = null;
                try {
                  const fleet = await resolveFleetNumber({ deviceId: did, vehicleRegistration: r.deviceName }).catch(() => null);
                  ccId = fleet ? await findVehicleCostCenterId(fleet).catch(() => null) : null;
                } catch (_) { ccId = null; }
                ccByDevice.set(did, ccId);
              }
              const comboResult = await alertCombos.handleDetection({
                alertId: r.id,
                deviceId: did,
                deviceName: r.deviceName,
                alarmType: r.alarmType,
                alarmText: r.alarmText,
                alarmTs: r.alarmTs ? new Date(r.alarmTs) : null,
                lat: r.lat,
                lon: r.lon,
                speed: r.speed ?? null,
                severity: r.severity,
                fleetNumber: did,
                sourceType: 'video',
                costCenterId: ccByDevice.get(did),
              });
              if (comboResult.action !== 'pass') comboHeld.add(r.id);
              for (const g of comboResult.groupRows) comboRaisedGroups.push(g);
            }
            if (comboHeld.size > 0) {
              newRecords = newRecords.filter(r => !comboHeld.has(r.id));
            }
          }
        } catch (comboErr) {
          console.error('[SYNC] combo gate error (processing unfiltered):', comboErr.message);
        }
      }

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
      let severityMap = null;
      try {
        severityMap = await getVideoSeverityMap([]);
      } catch (_) { /* fall back to PRIORITY_MAP */ }
      // The vehicle identifiers travel with the entry so the batch upsert can
      // (a) honour a vehicle alert override and (b) store a fleet number for
      // cost-centre attribution. cameraName already carries both ("FM10 - LDG067MP").
      const groupEntries = await Promise.all(Object.values(groupMap).map(async (r) => {
        let fleetNumber = null;
        let registration = null;
        try {
          fleetNumber = await resolveFleetNumber({ deviceId: r.deviceId, vehicleRegistration: r.deviceName }).catch(() => null);
        } catch (_) { fleetNumber = null; }
        const nameParts = String(r.deviceName || '').split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
        registration = nameParts.length > 1 ? nameParts[nameParts.length - 1] : (nameParts[0] || null);
        return {
          deviceId: r.deviceId,
          deviceName: r.deviceName,
          alarmType: r.alarmType,
          alarmText: r.alarmText,
          alertId: r.id,
          alarmTs: r.alarmTs ? new Date(r.alarmTs) : null,
          lat: r.lat,
          lon: r.lon,
          severity: resolveBaseSeverity(r.alarmType, severityMap),
          fleetNumber,
          registration,
        };
      }));
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
        } catch (groupErr) { console.error('[SYNC] group upsert failed — alert stored without a group:', groupErr.message); }
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

      // A completed combo has no per-record entry above (its detections were
      // held back), so broadcast each merged group explicitly.
      if (wsBroadcast && comboRaisedGroups.length > 0) {
        for (const g of comboRaisedGroups) {
          try {
            const groupId = g?.id != null ? String(g.id) : '';
            if (!groupId) continue;
            const comboType = String(g.alarm_type || g.combo_name || 'Combined alert');
            const base = String(g.severity || 'MEDIUM').toLowerCase();
            const count = Number(g.count || 1) || 1;
            const escalated = escalateSeverity(base, count);
            const ts = g.last_alert_ts ? new Date(g.last_alert_ts).toISOString() : new Date().toISOString();
            wsBroadcast('new-alert', {
              alert: {
                id: groupId,
                alert_id: groupId,
                device_id: g.device_id,
                deviceId: g.device_id,
                vehicleId: g.device_id,
                device_name: g.device_name,
                deviceName: g.device_name,
                alert_type: comboType,
                alarm_type: comboType,
                type: comboType,
                title: comboType,
                alarmText: comboType,
                timestamp: ts,
                alarmTs: ts,
                last_occurrence: ts,
                source_type: g.source_type || 'video',
                severity: escalated,
                priority: escalated,
                base_severity: base,
                escalated: escalated !== base,
                status: 'new',
                resolved: false,
                count,
                combo: g.combo_name || comboType,
                group_key: g.group_key || '',
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

const MIN_SYNC_TICK_MS = 5000;
const DEFAULT_SYNC_TICK_MS = 15000;

let autoSyncEnabled = false;

function scheduleAutoSync(tickStart, maxInterval) {
  const cycleMs = Date.now() - tickStart;
  // Pace tick-to-tick: run again shortly after a cycle ends, but never faster
  // than MIN_SYNC_TICK_MS and never slower than maxInterval. A plain
  // setInterval drops a tick whenever a cycle outlives the interval, which
  // silently doubles the delay before a new alert lands.
  const target = Math.max(MIN_SYNC_TICK_MS, Math.min(maxInterval, cycleMs + 1000));
  const wait = Math.max(0, tickStart + target - Date.now());
  syncState.lastPacedIntervalMs = target;
  if (!autoSyncEnabled) return;
  syncState.syncInterval = setTimeout(async () => {
    if (!autoSyncEnabled) return;
    const nextStart = Date.now();
    await runSync();
    scheduleAutoSync(nextStart, maxInterval);
  }, wait);
}

async function startAutoSync(intervalMs = DEFAULT_SYNC_TICK_MS) {
  const maxInterval = Math.max(MIN_SYNC_TICK_MS, intervalMs);
  autoSyncEnabled = true;
  const tickStart = Date.now();
  await runSync();
  scheduleAutoSync(tickStart, maxInterval);
  console.log(`[SYNC] Auto-sync paced (min ${MIN_SYNC_TICK_MS / 1000}s, max ${maxInterval / 1000}s, media fetch disabled)`);
}

function stopAutoSync() {
  autoSyncEnabled = false;
  if (syncState.syncInterval) {
    clearTimeout(syncState.syncInterval);
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
