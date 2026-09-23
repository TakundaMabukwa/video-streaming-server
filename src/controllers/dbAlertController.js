const db = require('../db');
const syncService = require('../services/syncService');
const { sendSuccess, sendError } = require('../helpers/response');
const { uploadDocument } = require('../helpers/storage');
const { transformDbAlert } = require('../helpers/transform');
const { getTelematicsNameSeverityMap, getPerCCSeverityMaps } = require('../db/alert_definitions');
const { findVehicleCostCenterId, resolveFleetNumber } = require('../services/costCenterLookup');
const { applyNcrDeduction } = require('../services/driverScoringService');

let wsBroadcast = null;
function setWsBroadcast(fn) { wsBroadcast = fn; }

/**
 * STRICT COST-CENTER ALERT RULE.
 * Builds the per-device filter + severity lookup for a batch of alert groups:
 * - Device belongs to cost center(s) → ONLY that CC's explicitly-added alert
 *   definitions apply. No global fallback, ever.
 * - Device matches no cost center → active GLOBAL definitions apply.
 * - `NCR:` rows always pass (system-generated from already-gated alerts).
 */
async function buildStrictAlertFilter(deviceCC) {
  const ccIds = [...new Set([...deviceCC.values()])];
  const perCCMaps = await getPerCCSeverityMaps(ccIds);
  const globalTelNameMap = await getTelematicsNameSeverityMap([]).catch(() => ({}));
  const telNameMapByCC = {};
  for (const cc of ccIds) {
    telNameMapByCC[cc] = await getTelematicsNameSeverityMap([cc]).catch(() => ({}));
  }

  const passes = (g) => {
    if (String(g.alarm_type || '').startsWith('NCR:')) return true;
    const ccId = deviceCC.get(g.device_id);
    const alarmKey = (g.alarm_type || '').toLowerCase();
    if (g.source_type === 'telematics') {
      const ccMap = ccId ? (telNameMapByCC[ccId] || {}) : {};
      const nameMap = { ...globalTelNameMap, ...ccMap };
      return !!nameMap[alarmKey];
    }
    const sigMap = ccId ? (perCCMaps[ccId] || {}) : (perCCMaps[0] || {});
    return !!sigMap[alarmKey];
  };

  const severityFor = (g) => {
    const ccId = deviceCC.get(g.device_id);
    if (g.source_type === 'telematics') {
      const ccMap = ccId ? (telNameMapByCC[ccId] || {}) : {};
      return { ...globalTelNameMap, ...ccMap };
    }
    return ccId ? (perCCMaps[ccId] || {}) : (perCCMaps[0] || {});
  };

  return { passes, severityFor };
}

async function batchResolveDeviceCC(alertGroups) {
  const deviceIds = [...new Set(alertGroups.map(g => g.device_id).filter(Boolean))];
  if (deviceIds.length === 0) return { fleetMap: new Map(), deviceCC: new Map() };

  const fleetMap = new Map();
  const results = await Promise.allSettled(
    deviceIds.map(async (did) => {
      const fleet = await resolveFleetNumber({
        deviceId: did,
        vehicleRegistration: alertGroups.find(g => g.device_id === did)?.device_name,
      }).catch(() => null);
      if (fleet) fleetMap.set(did, fleet);
      return { deviceId: did, fleet };
    })
  );

  const uniqueFleets = [...new Set([...fleetMap.values()])];
  const deviceCC = new Map();

  const ccResults = await Promise.allSettled(
    uniqueFleets.map(async (fn) => {
      const ccId = await findVehicleCostCenterId(fn).catch(() => null);
      return { fleet: fn, ccId };
    })
  );

  for (const r of ccResults) {
    if (r.status === 'fulfilled' && r.value.ccId) {
      for (const [did, fleet] of fleetMap) {
        if (fleet === r.value.fleet) deviceCC.set(did, r.value.ccId);
      }
    }
  }

  const resolved = [...deviceCC.values()].filter(Boolean).length;
  if (resolved > 0) {
    console.log(`[batchResolve] ${resolved}/${deviceIds.length} devices resolved to CCs`);
  } else if (deviceIds.length > 0) {
    console.log(`[batchResolve] WARNING: 0/${deviceIds.length} devices resolved to CCs`);
    const sample = results.slice(0, 3).map(r => r.status === 'fulfilled' ? r.value : r.reason?.message);
    console.log(`[batchResolve] Sample:`, JSON.stringify(sample));
  }

  return { fleetMap, deviceCC };
}

async function getAlertsList(req, res) {
  try {
    const { pageSize = 50, pageIndex = 1, deviceIds, alarmType, startTime, endTime } = req.query;
    const result = await db.getAlertsPaginated({
      pageSize: parseInt(pageSize),
      pageIndex: parseInt(pageIndex),
      deviceIds,
      alarmType,
      startTime,
      endTime,
    });
    sendSuccess(res, result, 'Alerts retrieved from local DB');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getAlertDetail(req, res) {
  try {
    const { alertId } = req.params;
    if (!alertId) return sendError(res, 'Alert ID required', 400);
    const alert = await db.getAlertWithMedia(alertId);
    if (!alert) return sendError(res, 'Alert not found', 404);
    sendSuccess(res, alert, 'Alert detail retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function triggerSync(req, res) {
  try {
    syncService.runSync();
    sendSuccess(res, { message: 'Sync triggered' }, 'Sync started');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getSyncStatus(req, res) {
  try {
    const status = syncService.getStatus();
    const stats = await db.getStats();
    const groupStats = await db.getAlertGroupStats();
    sendSuccess(res, { ...status, stats: { ...stats, ...groupStats } }, 'Sync status retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getDevices(req, res) {
  try {
    const result = await db.query(
      `SELECT device_id, device_name, SUM(count) as alert_count,
       MAX(last_alert_ts) as last_alert_ts
       FROM alert_groups
       GROUP BY device_id, device_name
       ORDER BY last_alert_ts DESC NULLS LAST
       LIMIT 1000`
    );
    sendSuccess(res, { records: result.rows, total: result.rows.length }, 'Devices from local DB');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getAlertTypes(req, res) {
  try {
    const result = await db.query(
      `SELECT alarm_type, SUM(count) as alert_count
       FROM alert_groups
       GROUP BY alarm_type
       ORDER BY alert_count DESC
       LIMIT 200`
    );
    sendSuccess(res, result.rows, 'Alert types from local DB');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getActiveAlerts(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 2000;
    const groups = await db.getActiveAlertGroupsWithMedia({ limit });

    const { deviceCC } = await batchResolveDeviceCC(groups);
    const { passes, severityFor } = await buildStrictAlertFilter(deviceCC);

    const alerts = groups
      .filter((g) => passes(g))
      .map((g) => {
        const t = transformDbAlert(g, severityFor(g));
        t.count = g.count || 1;
        return t;
      });

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getResolvedAlerts(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 2000;
    const groups = await db.getResolvedAlertGroupsWithMedia({ limit });

    const { deviceCC } = await batchResolveDeviceCC(groups);
    const { passes, severityFor } = await buildStrictAlertFilter(deviceCC);

    const alerts = groups
      .filter((g) => passes(g))
      .map((g) => {
        const t = transformDbAlert(g, severityFor(g));
        t.count = g.count || 1;
        return t;
      });

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getActiveAlertsAll(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 2000;
    const groups = await db.getActiveAlertGroupsAll({ limit });

    const { deviceCC } = await batchResolveDeviceCC(groups);
    const { passes, severityFor } = await buildStrictAlertFilter(deviceCC);

    const alerts = groups
      .filter((g) => passes(g))
      .map((g) => transformDbAlert(g, severityFor(g)));

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertById(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);

    // Try group lookup first, fall back to individual alert
    let alert = await db.getAlertGroupByAlertId(id);
    if (!alert) {
      alert = await db.getAlertWithMedia(id);
      if (!alert) {
        return res.status(404).json({ success: false, message: `Alert ${id} not found` });
      }
      alert.media = alert.media || [];
      // If individual alert has no media, fetch on-demand for this specific alert ID
      if (!alert.media || alert.media.length === 0) {
        const dbAlert = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
        if (dbAlert.rows.length > 0) {
          console.log(`[ALERT] On-demand media fetch for alert ${id}`);
          const newMedia = await syncService.fetchMediaOnDemand(dbAlert.rows[0]);
          alert.media = newMedia;
        }
      }
    } else {
      const media = await db.getMediaForAlert(alert.last_alert_id);
      alert.media = media || [];
    }

    const { deviceCC } = await batchResolveDeviceCC([alert]);
    const ccId = deviceCC.get(alert.device_id);
    const ccIds = ccId ? [ccId] : [];
    const perCCMaps = await getPerCCSeverityMaps(ccIds);
    const severityMap = (ccId && perCCMaps[ccId]) || perCCMaps[0] || {};

    const transformed = transformDbAlert(alert, severityMap);
    transformed.count = alert.count || 1;

    // Fetch speed from telematics_events using fleet_number and alert timestamp
    // Look within 5 minute range of the video alert
    // Extract fleet_number from vehicle_registration (e.g., "EX69 - LDR067MP" -> "EX69")
    let fleetNum = transformed.fleet_number || alert.fleet_number;
    if (!fleetNum && transformed.vehicle_registration) {
      const parts = transformed.vehicle_registration.split(' - ');
      fleetNum = parts[0]?.trim();
    }
    const alertTime = transformed.timestamp || alert.alarm_ts;
    
    if (fleetNum && alertTime) {
      try {
        console.log(`[SPEED] Looking up speed for fleet: ${fleetNum}, time: ${alertTime}`);
        const speedResult = await db.query(
          `SELECT speed, distance, duration_seconds FROM telematics_events
           WHERE fleet_number = $1 AND speed IS NOT NULL 
           AND event_time >= $2::timestamptz - INTERVAL '5 minutes'
           AND event_time <= $2::timestamptz + INTERVAL '5 minutes'
           ORDER BY ABS(EXTRACT(EPOCH FROM (event_time - $2::timestamptz))) ASC
           LIMIT 1`,
          [fleetNum, alertTime]
        );
        console.log(`[SPEED] Result: ${speedResult.rows.length} rows`);
        if (speedResult.rows.length > 0) {
          transformed.speed = speedResult.rows[0].speed;
          transformed.distance = speedResult.rows[0].distance;
          transformed.duration_seconds = speedResult.rows[0].duration_seconds;
          transformed.metadata = { ...transformed.metadata, speed: speedResult.rows[0].speed };
          console.log(`[SPEED] Set speed: ${speedResult.rows[0].speed} for fleet ${fleetNum}`);
        }
      } catch (e) { console.log(`[SPEED] Error: ${e.message}`); }
    } else if (fleetNum) {
      // Fallback: get most recent speed for this fleet
      try {
        const speedResult = await db.query(
          `SELECT speed, distance, duration_seconds FROM telematics_events
           WHERE fleet_number = $1 AND speed IS NOT NULL
           ORDER BY event_time DESC LIMIT 1`,
          [fleetNum]
        );
        if (speedResult.rows.length > 0) {
          transformed.speed = speedResult.rows[0].speed;
          transformed.distance = speedResult.rows[0].distance;
          transformed.duration_seconds = speedResult.rows[0].duration_seconds;
          transformed.metadata = { ...transformed.metadata, speed: speedResult.rows[0].speed };
        }
      } catch (e) { /* non-critical */ }
    }

    const media = alert.media || [];
    transformed.screenshots = media
      .filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01')
      .map((m, i) => ({
        id: m.id || `media-${i}`,
        url: m.file_url,
        storage_url: m.file_url,
        timestamp: m.created_at || m.alarm_time,
      }));
    transformed.videos = [];

    const entries = media
      .filter((m) => m.file_type === '02')
      .map((m) => ({
        id: m.id,
        label: 'Alert Media',
        url: m.file_url,
        fileUrl: m.file_url,
        timestamp: m.created_at,
      }));

    res.json({ success: true, alert: { ...transformed, videos: entries, videoCaptures: entries }, target: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertScreenshots(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);

    // Try group lookup by last_alert_id
    let group = await db.getAlertGroupByAlertId(id);
    const alertId = group ? group.last_alert_id : id;

    let alert = await db.getAlertWithMedia(alertId);
    if (!alert) {
      return res.json({ success: true, screenshots: [], count: 0, source: 'eps-db' });
    }

    const screenshots = (alert.media || [])
      .filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01')
      .map((m, i) => ({
        id: m.id || `shot-${i}`,
        url: m.file_url,
        storage_url: m.file_url,
        timestamp: m.created_at || m.alarm_time,
      }));

    res.json({ success: true, screenshots, count: screenshots.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertMedia(req, res) {
  try {
    const { id } = req.params;
    const ensureMedia = req.query.ensureMedia === 'true';
    if (!id) return sendError(res, 'Alert ID required', 400);

    // Try group lookup, fall back to individual alert
    let group = await db.getAlertGroupByAlertId(id);
    const alertId = group ? group.last_alert_id : id;

    let alert = await db.getAlertWithMedia(alertId);
    const media = alert?.media || [];

    // If ensureMedia and no media, fetch on-demand from skycamx API
    if (ensureMedia && media.length === 0) {
      console.log(`[ALERT] ensureMedia=true, no media found for alert ${id}, fetching from skycamx API...`);
      
      // Try to find raw alert record
      let rawAlert = null;
      if (group) {
        // Use group info to construct a minimal alert record for API call
        rawAlert = await db.query('SELECT * FROM alerts WHERE id = $1', [alertId]);
        if (rawAlert.rows.length > 0) {
          rawAlert = rawAlert.rows[0];
        } else {
          // Alert not in alerts table but group exists - construct from group
          rawAlert = {
            id: alertId,
            deviceId: group.device_id,
            deviceName: group.device_name,
            alarmType: group.alarm_type,
            alarmTs: group.last_alert_ts,
          };
        }
      } else {
        rawAlert = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
        if (rawAlert.rows.length > 0) {
          rawAlert = rawAlert.rows[0];
        }
      }

      if (rawAlert) {
        console.log(`[ALERT] Calling skycamx /alarm/file/id for alarmId=${rawAlert.id}, device=${rawAlert.deviceId}`);
        const newMedia = await syncService.fetchMediaOnDemand(rawAlert);
        if (newMedia.length > 0) {
          console.log(`[ALERT] Got ${newMedia.length} media files from skycamx API`);
          if (alert) {
            alert.media = newMedia;
          } else {
            alert = { ...rawAlert, media: newMedia };
          }
        } else {
          console.log(`[ALERT] No media returned from skycamx API for alarmId=${rawAlert.id}`);
        }
      }
    }

    const finalMedia = alert?.media || [];
    const finalImages = finalMedia.filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01');
    let finalVideoFiles = finalMedia.filter((m) => m.file_type === '02');

    // Refetch replay URLs for video files — Mettax CDN signed URLs expire after ~30 min
    if (ensureMedia && finalVideoFiles.length > 0) {
      const staleVideo = finalVideoFiles[0];
      const rawAlert = alert || await db.query('SELECT * FROM alerts WHERE id = $1', [alertId]).then(r => r.rows[0]);
      if (rawAlert) {
        const ts = rawAlert.alarmTs || rawAlert.alarm_ts || rawAlert.timestamp;
        const devId = rawAlert.deviceId || rawAlert.device_id;
        if (ts && devId) {
          const tsDate = new Date(ts);
          const tsEnd = new Date(tsDate.getTime() + 15 * 1000);
          const freshUrl = await syncService.fetchReplayUrl(devId, 1, ts, tsEnd.toISOString().replace('T', ' ').slice(0, 19));
          if (freshUrl) {
            console.log(`[ALERT] Refreshed expired replay URL for alert ${alertId}`);
            finalVideoFiles = [{ ...staleVideo, file_url: freshUrl }];
          }
        }
      }
    }

    let severityMap = {};
    if (alert) {
      try {
        const { deviceCC } = await batchResolveDeviceCC([alert]);
        const ccId = deviceCC.get(alert.device_id);
        const ccIds = ccId ? [ccId] : [];
        const perCCMaps = await getPerCCSeverityMaps(ccIds);
        severityMap = (ccId && perCCMaps[ccId]) || perCCMaps[0] || {};
      } catch (mapErr) {
        console.error(`[ALERT] severityMap resolution error for ${id}:`, mapErr.message);
      }
    }

    const transformed = alert ? transformDbAlert(alert, severityMap) : null;
    if (group && transformed) transformed.count = group.count;

    const screenshots = finalImages.map((m, i) => ({
      id: m.id || `shot-${i}`,
      url: m.file_url ? `/api/video-server/playback/image-proxy?url=${encodeURIComponent(m.file_url)}` : null,
      storage_url: m.file_url,
      timestamp: m.created_at || m.alarm_time,
    }));

    const entries = finalVideoFiles.map((m) => {
      const flvProxyUrl = m.file_url
        ? `/api/video-server/playback/flv-proxy?url=${encodeURIComponent(m.file_url)}`
        : null;
      return {
        id: m.id,
        label: 'Alert Media',
        url: flvProxyUrl || m.file_url,
        flvProxyUrl,
        fileUrl: m.file_url,
        fileType: m.file_type || '02',
        isFlv: true,
        timestamp: m.created_at || m.alarm_time,
      };
    });

    const primaryUrl = entries[0]?.url || '';

    res.json({
      success: true,
      alert: transformed,
      screenshots,
      videos: entries,
      captures: entries,
      alertCaptures: entries,
      clipUrls: {
        pre: primaryUrl,
        post: primaryUrl,
        camera: primaryUrl,
        preRaw: primaryUrl,
        postRaw: primaryUrl,
      },
      source: 'eps-db',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

// transformDbAlert and getAlertCoordinates moved to helpers/transform.js

async function getAlertHistory(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 2000);
    const deviceId = String(req.query.device_id || req.query.vehicleId || '').trim();
    const includeResolved = req.query.include_resolved === 'true';

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const params = [cutoff];
    let where = 'alarm_ts >= $1';
    if (!includeResolved) {
      where += ' AND (resolved IS NOT TRUE) AND (false_alert IS NOT TRUE)';
    }
    if (deviceId) {
      params.push(deviceId);
      where += ` AND device_id = $${params.length}`;
    }
    params.push(limit);

    const result = await db.query(
      `SELECT id, device_id, alarm_type, alarm_ts, source_type, status, resolved, false_alert, notes, created_at, updated_at
       FROM alerts
       WHERE ${where}
       ORDER BY alarm_ts DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({
      success: true,
      alerts: result.rows,
      history: result.rows,
      data: result.rows,
      count: result.rows.length,
      days,
      device_id: deviceId || null,
    });
  } catch (error) {
    console.error('[Alerts] History error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}

async function acknowledgeAlert(req, res) {
  res.json({ success: true, alertId: req.params.id, action: 'acknowledge', message: 'EPS read-only: acknowledged locally' });
}

async function resolveAlert(req, res) {
  try {
    const { id } = req.params;
    const {
      userId,
      notes,
      closureType = 'resolved',
      documents: docData,
      action_taken,
      ncr_classification,
      close_reason,
      reported_by,
      resolveScope = 'all_group',
      group_key: groupKeyFromBody,
      device_id: deviceIdFromBody,
      alarm_type: alarmTypeFromBody,
      incident: incidentData = {},
    } = req.body || {};

    const isFalse = closureType === 'false_alert';
    const now = new Date().toISOString();
    const clean = (v) => String(v == null ? '' : v).trim();

    // Alert row is optional: group cards can carry last_alert_id or group id.
    const alertResult = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
    const alert = alertResult.rows[0] || null;

    // Resolve the group robustly: explicit key → last_alert_id → group PK → device+type.
    let group = null;
    if (groupKeyFromBody) {
      group = await db.getAlertGroupByKey(groupKeyFromBody);
    }
    if (!group && id) {
      group = await db.getAlertGroupByAlertId(id);
    }
    if (!group && id && /^\d+$/.test(String(id))) {
      group = await db.getAlertGroupById(Number(id));
    }
    if (!group) {
      const deviceId = clean(deviceIdFromBody || alert?.device_id).toLowerCase();
      const alarmType = clean(alarmTypeFromBody || alert?.alarm_type).toLowerCase();
      if (deviceId && alarmType) {
        group = await db.getAlertGroupByKey(`${deviceId}:${alarmType}`);
      }
    }

    const resolvedGroupKey = group ? group.group_key : null;
    const targetDeviceId = clean(group?.device_id || deviceIdFromBody || alert?.device_id);
    const targetAlarmType = clean(group?.alarm_type || alarmTypeFromBody || alert?.alarm_type);
    const useAllGroup = resolveScope !== 'this_alert';

    // Kill every active group for this vehicle+type so the board card cannot linger.
    let affectedGroups = [];
    if (targetDeviceId && targetAlarmType && useAllGroup) {
      const allForType = await db.query(
        `SELECT id, group_key, count, last_alert_id, device_id, alarm_type FROM alert_groups
         WHERE device_id = $1 AND alarm_type = $2 AND resolved = FALSE
         FOR UPDATE`,
        [targetDeviceId, targetAlarmType]
      );
      affectedGroups = allForType.rows;
    } else if (group) {
      affectedGroups = [group];
    }

    if (affectedGroups.length === 0 && !alert) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    for (const g of affectedGroups) {
      await db.resolveAlertGroup(g.group_key, {
        resolved: true,
        false_alert: isFalse,
        resolved_by: userId || null,
        resolved_at: now,
        notes: notes || null,
      });
    }

    if (alert) {
      const updates = { resolved: true, false_alert: isFalse };
      if (notes) updates.notes = notes;
      await db.updateAlertStatus(alert.id, updates);
    }

    // Clear every open child alert for this vehicle+type (and the direct id).
    if (targetDeviceId && targetAlarmType) {
      await db.query(
        `UPDATE alerts SET resolved = TRUE, false_alert = $1::boolean, updated_at = $2::timestamptz
         WHERE device_id = $3 AND alarm_type = $4 AND resolved = FALSE`,
        [isFalse, now, targetDeviceId, targetAlarmType]
      );
    }
    if (alert) {
      await db.query(
        `UPDATE alerts SET resolved = TRUE, false_alert = $1::boolean, updated_at = $2::timestamptz
         WHERE id = $3 AND resolved = FALSE`,
        [isFalse, now, alert.id]
      );
    }

    let count = affectedGroups.reduce((sum, g) => sum + (Number(g.count) || 1), 0) || 1;

    // Documents: store on Supabase, keep the link for the incident register
    const docs = [];
    if (docData) {
      const docEntries = Array.isArray(docData) ? docData : [docData];
      for (const doc of docEntries) {
        if (doc.type && doc.link) {
          docs.push({
            type: doc.type,
            timestamp: doc.timestamp || now,
            filled_by: doc.filled_by || userId || 'unknown',
            link: doc.link,
          });
        }
      }
      if (docs.length > 0 && alert) {
        await db.addAlertDocument(alert.id, docs);
      }
    }

    // Capture / update the incident register row for NCR closures
    const isNcr = !!alert && (
      String(alert.alarm_type || '').startsWith('NCR:')
      || closureType === 'ncr'
      || !!(incidentData.infringement || ncr_classification || close_reason || action_taken)
    );

    let incident = null;
    let deduction = { deducted: false };

    if (isNcr) {
      // Resolve the human fleet number (device ids are Geotab/Mettax codes,
      // e.g. '221085903184' -> 'EX41'), preferring an explicit fleet from the form.
      const fleetNumber = String(incidentData.fleet_number || incidentData.fleetNumber || '').trim()
        || (await resolveFleetNumber({
          deviceId: alert.device_id,
          vehicleRegistration: alert.vehicle_registration || alert.vehicle_reg,
          fleetNumber: alert.fleet_number,
        }).catch(() => null))
        || alert.device_id;

      const costCenterId = alert.cost_center_id
        || (await findVehicleCostCenterId(fleetNumber).catch(() => null));

      incident = await db.upsertIncidentFromAlert({
        alertId: id,
        alertGroupKey: resolvedGroupKey,
        alarmType: alert.alarm_type,
        sourceType: alert.source_type || 'telematics',
        deviceId: alert.device_id,
        fleetNumber,
        costCenterId,
        filledBy: userId || 'SYSTEM',
        status: isFalse ? 'FALSE_ALERT' : 'OPEN',
        controller: reported_by || incidentData.controller || incidentData.reported_by || null,
        driver_name:
          incidentData.driver_name
          || incidentData.driverName
          || incidentData['name & surname']
          || null,
        contact_number: incidentData.contact_number || incidentData.contactNumber || null,
        id_number: incidentData.id_number || null,
        division: incidentData.division || null,
        infringement: ncr_classification || incidentData.infringement || alert.alarm_type,
        infringement_detail: close_reason || incidentData.infringement_detail || notes || null,
        action_taken: action_taken || incidentData.action_taken || null,
        outcome: incidentData.outcome || null,
        notes: notes || null,
        document_link: docs.length > 0 ? docs[0].link : null,
        document_type: docs.length > 0 ? docs[0].type : null,
      });

      if (incident) {
        if (isFalse) {
          await db.updateIncidentFields(incident.id, { status: 'FALSE_ALERT', closure_type: closureType });
        } else {
          // Deduct once per closed NCR (never for false alerts)
          try {
            deduction = await applyNcrDeduction(fleetNumber, alert.alarm_type);
          } catch (deductErr) {
            console.error('[ResolveAlert] NCR deduction error:', deductErr.message);
          }
          const resFields = {
            status: 'RESOLVED',
            resolved_by: userId || null,
            resolved_at: now,
            closure_type: closureType,
          };
          if (deduction.deducted) resFields.deduction_applied = deduction.weighting;
          await db.updateIncidentFields(incident.id, resFields);
        }
      }
    }

    res.json({
      success: true,
      alertId: id,
      action: 'close',
      closureType,
      resolveScope,
      resolved: true,
      false_alert: isFalse,
      documents: docs,
      incident: incident || null,
      deduction,
      count,
      group_key: resolvedGroupKey,
      message: affectedGroups.length > 0
        ? `Resolved ${affectedGroups.length} active group(s) for this vehicle+type (${count} alerts)`
        : `Alert ${id} resolved successfully`,
    });

    if (wsBroadcast) {
      const broadcastPayload = {
        id,
        alert_id: id,
        status: 'resolved',
        resolved: true,
        false_alert: isFalse,
        closureType,
        resolved_by: userId || null,
        group_key: resolvedGroupKey,
        device_id: targetDeviceId || null,
        alert_type: targetAlarmType || null,
      };
      wsBroadcast('alert-status-changed', { alert: broadcastPayload });
      for (const g of affectedGroups) {
        if (String(g.last_alert_id) && String(g.last_alert_id) !== String(id)) {
          wsBroadcast('alert-status-changed', {
            alert: {
              id: g.last_alert_id,
              alert_id: g.last_alert_id,
              status: 'resolved',
              resolved: true,
              false_alert: isFalse,
              resolved_by: userId || null,
              group_key: g.group_key,
            },
          });
        }
      }
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function escalateAlert(req, res) {
  res.json({ success: true, alertId: req.params.id, action: 'escalate', message: 'EPS read-only: escalated locally' });
}

async function markFalseAlert(req, res) {
  try {
    const { id } = req.params;
    const { userId, notes, group_key, device_id, alarm_type } = req.body || {};
    const clean = (v) => String(v == null ? '' : v).trim();

    const alertRow = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
    const alert = alertRow.rows[0] || null;

    let group = null;
    if (group_key) group = await db.getAlertGroupByKey(group_key);
    if (!group) group = await db.getAlertGroupByAlertId(id);
    if (!group && /^\d+$/.test(String(id))) group = await db.getAlertGroupById(Number(id));
    if (!group && (device_id || alert?.device_id) && (alarm_type || alert?.alarm_type)) {
      group = await db.getAlertGroupByKey(`${clean(device_id || alert?.device_id)}:${clean(alarm_type || alert?.alarm_type)}`);
    }

    const targetDeviceId = clean(group?.device_id || device_id || alert?.device_id);
    const targetAlarmType = clean(group?.alarm_type || alarm_type || alert?.alarm_type);
    const now = new Date().toISOString();

    if (!alert && !group && !(targetDeviceId && targetAlarmType)) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    // Kill every active sibling group for this vehicle+type so the board card is gone.
    let resolvedGroups = 0;
    if (targetDeviceId && targetAlarmType) {
      const upd = await db.query(
        `UPDATE alert_groups SET resolved = TRUE, false_alert = TRUE, resolved_by = $1, resolved_at = $2::timestamptz, notes = COALESCE($3, notes), updated_at = NOW()
         WHERE device_id = $4 AND alarm_type = $5 AND resolved = FALSE`,
        [userId || null, now, notes || null, targetDeviceId, targetAlarmType]
      );
      resolvedGroups = upd.rowCount || 0;
      await db.query(
        `UPDATE alerts SET resolved = TRUE, false_alert = TRUE, updated_at = $2::timestamptz
         WHERE device_id = $3 AND alarm_type = $4 AND resolved = FALSE`,
        [true, now, targetDeviceId, targetAlarmType]
      );
    }

    if (alert) {
      await db.updateAlertStatus(alert.id, { resolved: true, false_alert: true, notes: notes || undefined });
    }

    if (wsBroadcast) {
      const payloadBase = {
        status: 'resolved',
        resolved: true,
        false_alert: true,
        resolved_by: userId || null,
        device_id: targetDeviceId || null,
        alert_type: targetAlarmType || null,
      };
      wsBroadcast('alert-status-changed', { alert: { ...payloadBase, id, alert_id: id } });
      if (targetDeviceId && targetAlarmType) {
        const siblings = await db.query(
          `SELECT last_alert_id FROM alert_groups WHERE device_id = $1 AND alarm_type = $2 AND resolved = TRUE ORDER BY updated_at DESC LIMIT 50`,
          [targetDeviceId, targetAlarmType]
        );
        for (const row of siblings.rows) {
          if (row.last_alert_id && String(row.last_alert_id) !== String(id)) {
            wsBroadcast('alert-status-changed', {
              alert: { ...payloadBase, id: row.last_alert_id, alert_id: row.last_alert_id },
            });
          }
        }
      }
    }

    res.json({
      success: true,
      alertId: id,
      action: 'mark-false',
      resolved: true,
      false_alert: true,
      groups: resolvedGroups,
      count: resolvedGroups || (group ? group.count : 1),
      message: resolvedGroups > 0
        ? `Marked false; ${resolvedGroups} active group(s) closed for this vehicle+type`
        : `Alert ${id} marked as false alarm`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function uploadDocumentToAlert(req, res) {
  try {
    const { id } = req.params;
    const { type, filled_by, link, url } = req.body || {};

    if (!type) {
      return res.status(400).json({ success: false, message: 'Document type is required' });
    }

    // Accept either a multipart upload (file) or pre-uploaded metadata (link/url).
    let publicUrl;
    if (req.files && req.files.file) {
      const file = req.files.file;
      const safeName = `${id}_${type}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      publicUrl = await uploadDocument(file.data, safeName, file.mimetype);
    } else {
      publicUrl = String(link || url || '').trim();
      if (!publicUrl) {
        return res.status(400).json({ success: false, message: 'Multipart file or a JSON body with "link" is required' });
      }
    }

    const timestamp = (req.body && req.body.timestamp) || new Date().toISOString();

    const document = {
      type,
      timestamp,
      filled_by: filled_by || 'unknown',
      link: publicUrl,
    };

    await db.addAlertDocument(id, document);

    res.json({
      success: true,
      alertId: id,
      action: 'document-uploaded',
      document,
      message: `Document uploaded to alert ${id}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function followUpAlert(req, res) {
  try {
    const { id } = req.params;
    const { originalSeverity } = req.body || {};

    // Try group lookup by last_alert_id first
    let group = await db.getAlertGroupByAlertId(id);

    // If not found, try to find via the alerts table (telematics alerts may not match group last_alert_id)
    if (!group) {
      const alertRow = await db.query('SELECT device_id, alarm_type FROM alerts WHERE id = $1', [id]);
      if (alertRow.rows.length > 0) {
        const { device_id, alarm_type } = alertRow.rows[0];
        const groupKey = `${device_id}:${alarm_type}`.toLowerCase();
        group = await db.getAlertGroupByKey(groupKey);
      }
    }

    if (!group) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    await db.resolveAlertGroup(group.group_key, {
      follow_up: true,
      follow_up_at: new Date().toISOString(),
      original_severity: originalSeverity || group.original_severity || null,
    });

    res.json({
      success: true,
      alertId: id,
      action: 'follow-up',
      follow_up: true,
      follow_up_at: new Date().toISOString(),
      message: `Alert ${id} set to follow-up (15 min low priority)`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function clearFollowUp(req, res) {
  try {
    const { id } = req.params;

    let group = await db.getAlertGroupByAlertId(id);
    if (!group) {
      const alertRow = await db.query('SELECT device_id, alarm_type FROM alerts WHERE id = $1', [id]);
      if (alertRow.rows.length > 0) {
        const { device_id, alarm_type } = alertRow.rows[0];
        const groupKey = `${device_id}:${alarm_type}`.toLowerCase();
        group = await db.getAlertGroupByKey(groupKey);
      }
    }

    if (!group) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    await db.resolveAlertGroup(group.group_key, {
      follow_up: false,
      follow_up_at: null,
    });

    res.json({ success: true, alertId: id, action: 'clear-follow-up' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function resolveAlertsBulk(req, res) {
  try {
    const { alertIds, userId, notes, closureType = 'resolved' } = req.body || {};
    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return res.status(400).json({ success: false, message: 'alertIds array is required' });
    }

    const isFalse = closureType === 'false_alert';
    const now = new Date().toISOString();

    const uniqueIds = [...new Set(alertIds.map(String).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return res.json({ success: true, resolved: 0, total: 0, message: 'No alerts to resolve' });
    }

    const n = uniqueIds.length;
    const pLast = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');
    const pPk = uniqueIds.map((_, i) => `$${i + 1 + n}`).join(', ');
    const pKey = uniqueIds.map((_, i) => `$${i + 1 + n * 2}`).join(', ');
    const pFalse = n * 3 + 1;
    const pBy = n * 3 + 2;
    const pAt = n * 3 + 3;
    const pNotes = n * 3 + 4;
    const idParams = [...uniqueIds, ...uniqueIds, ...uniqueIds];
    // directUpdate binds [isFalse, now, ...uniqueIds] → ids start at $3
    const pDirectIds = uniqueIds.map((_, i) => `$${i + 3}`).join(', ');
    // siblingCount binds [...idParams, ...uniqueIds] → ids start after 3n
    const pSiblingIds = uniqueIds.map((_, i) => `$${i + 1 + n * 3}`).join(', ');
    // orphanSiblings binds [...uniqueIds] only → ids start at $1
    const pPlainIds = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');

    // Match groups by last_alert_id OR group primary key OR group_key so board ids always hit.
    const groupUpdate = await db.query(
      `UPDATE alert_groups SET resolved = TRUE, false_alert = $${pFalse}::boolean, resolved_by = $${pBy}, resolved_at = $${pAt}::timestamptz, notes = COALESCE($${pNotes}, notes), updated_at = NOW()
       WHERE resolved = FALSE AND (
         last_alert_id IN (${pLast})
         OR id::text IN (${pPk})
         OR group_key IN (${pKey})
       )`,
      [...idParams, isFalse, userId || null, now, notes || null]
    );

    // Every vehicle+type touched by those groups — clear ALL sibling active groups too.
    const groupResult = await db.query(
      `SELECT DISTINCT device_id, alarm_type FROM alert_groups
       WHERE last_alert_id IN (${pLast})
          OR id::text IN (${pPk})
          OR group_key IN (${pKey})`,
      idParams
    );

    for (const g of groupResult.rows) {
      if (!g.device_id || !g.alarm_type) continue;
      await db.query(
        `UPDATE alert_groups SET resolved = TRUE, false_alert = $1::boolean, resolved_by = $2, resolved_at = $3::timestamptz, notes = COALESCE($4, notes), updated_at = NOW()
         WHERE device_id = $5 AND alarm_type = $6 AND resolved = FALSE`,
        [isFalse, userId || null, now, notes || null, g.device_id, g.alarm_type]
      );
      await db.query(
        `UPDATE alerts SET resolved = TRUE, false_alert = $1::boolean, updated_at = $2::timestamptz
         WHERE device_id = $3 AND alarm_type = $4 AND resolved = FALSE`,
        [isFalse, now, g.device_id, g.alarm_type]
      );
    }

    const directUpdate = await db.query(
      `UPDATE alerts SET resolved = TRUE, false_alert = $1::boolean, updated_at = $2::timestamptz
       WHERE id IN (${pDirectIds}) AND resolved = FALSE`,
      [isFalse, now, ...uniqueIds]
    );

    // If groups never matched but direct alert rows did, still clear sibling groups
    // for the same vehicle+type so the board cannot keep an active card.
    if (groupResult.rows.length === 0 && directUpdate.rowCount > 0) {
      const orphanSiblings = await db.query(
        `SELECT DISTINCT device_id, alarm_type FROM alerts
         WHERE id IN (${pPlainIds}) AND device_id IS NOT NULL AND alarm_type IS NOT NULL`,
        uniqueIds
      );
      for (const g of orphanSiblings.rows) {
        await db.query(
          `UPDATE alert_groups SET resolved = TRUE, false_alert = $1::boolean, resolved_by = $2, resolved_at = $3::timestamptz, notes = COALESCE($4, notes), updated_at = NOW()
           WHERE device_id = $5 AND alarm_type = $6 AND resolved = FALSE`,
          [isFalse, userId || null, now, notes || null, g.device_id, g.alarm_type]
        );
      }
    }

    const siblingCount = await db.query(
      `SELECT COUNT(*)::int AS n FROM alert_groups WHERE resolved = FALSE AND (device_id, alarm_type) IN (
         SELECT device_id, alarm_type FROM alert_groups WHERE last_alert_id IN (${pLast}) OR id::text IN (${pPk}) OR group_key IN (${pKey})
         UNION
         SELECT device_id, alarm_type FROM alerts WHERE id IN (${pSiblingIds}) AND device_id IS NOT NULL AND alarm_type IS NOT NULL
       )`,
      [...idParams, ...uniqueIds]
    );
    const stillActive = siblingCount.rows[0]?.n || 0;
    const resolvedCount = Math.max(
      groupResult.rows.length,
      groupUpdate.rowCount || 0,
      directUpdate.rowCount || 0,
      0
    );

    res.json({
      success: true,
      resolved: resolvedCount,
      groups: groupResult.rows.length,
      total: alertIds.length,
      stillActive,
      message: resolvedCount > 0
        ? `${resolvedCount} group(s) resolved; ${stillActive} sibling group(s) still open for same vehicle+type`
        : `Matched ${uniqueIds.length} id(s); no active groups updated`,
    });

    if (wsBroadcast) {
      for (const bid of uniqueIds) {
        wsBroadcast('alert-status-changed', {
          alert: {
            id: bid,
            alert_id: bid,
            status: 'resolved',
            resolved: true,
            false_alert: isFalse,
            resolved_by: userId || null,
          },
        });
      }
      for (const g of groupResult.rows) {
        const sibling = await db.query(
          `SELECT last_alert_id FROM alert_groups WHERE device_id = $1 AND alarm_type = $2 AND resolved = TRUE ORDER BY updated_at DESC LIMIT 50`,
          [g.device_id, g.alarm_type]
        );
        for (const row of sibling.rows) {
          if (row.last_alert_id && !uniqueIds.includes(String(row.last_alert_id))) {
            wsBroadcast('alert-status-changed', {
              alert: {
                id: row.last_alert_id,
                alert_id: row.last_alert_id,
                status: 'resolved',
                resolved: true,
                false_alert: isFalse,
                resolved_by: userId || null,
              },
            });
          }
        }
      }
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getResolvedAlertCount(req, res) {
  try {
    const count = await db.getResolvedAlertGroupCount();
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, count: 0, message: error.message });
  }
}

module.exports = {
  getAlertsList,
  getAlertDetail,
  triggerSync,
  getSyncStatus,
  getDevices,
  getAlertTypes,
  getActiveAlerts,
  getActiveAlertsAll,
  getResolvedAlerts,
  getResolvedAlertCount,
  getAlertById,
  getAlertScreenshots,
  getAlertMedia,
  getAlertHistory,
  acknowledgeAlert,
  resolveAlert,
  resolveAlertsBulk,
  escalateAlert,
  markFalseAlert,
  uploadDocumentToAlert,
  followUpAlert,
  clearFollowUp,
  setWsBroadcast,
};
