const db = require('../db');
const syncService = require('../services/syncService');
const { sendSuccess, sendError } = require('../helpers/response');
const { uploadDocument } = require('../helpers/storage');
const { transformDbAlert } = require('../helpers/transform');
const { getVideoSeverityMap } = require('../db/alert_definitions');

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
    const severityMap = await getVideoSeverityMap();

    // Read from alert_groups for grouped view
    const groups = await db.getActiveAlertGroupsWithMedia({ limit });

    const alerts = [];
    for (const g of groups) {
      const transformed = transformDbAlert(g, severityMap);
      
      // Fetch speed from telematics_events using fleet_number
      let fleetNum = transformed.fleet_number || g.fleet_number;
      if (!fleetNum && transformed.vehicle_registration) {
        const parts = transformed.vehicle_registration.split(' - ');
        fleetNum = parts[0]?.trim();
      }
      const alertTime = transformed.timestamp || g.last_alert_ts || g.alarm_ts;
      
      if (fleetNum && alertTime) {
        try {
          const speedResult = await db.query(
            `SELECT speed, distance, duration_seconds FROM telematics_events
             WHERE fleet_number = $1 AND speed IS NOT NULL 
             AND event_time >= $2::timestamptz - INTERVAL '5 minutes'
             AND event_time <= $2::timestamptz + INTERVAL '5 minutes'
             ORDER BY ABS(EXTRACT(EPOCH FROM (event_time - $2::timestamptz))) ASC
             LIMIT 1`,
            [fleetNum, alertTime]
          );
          if (speedResult.rows.length > 0) {
            transformed.speed = speedResult.rows[0].speed;
            transformed.distance = speedResult.rows[0].distance;
            transformed.duration_seconds = speedResult.rows[0].duration_seconds;
            transformed.metadata = { ...transformed.metadata, speed: speedResult.rows[0].speed };
          }
        } catch (e) { /* non-critical */ }
      }
      
      transformed.count = g.count || 1;
      alerts.push(transformed);
    }

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getResolvedAlerts(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 2000;
    const severityMap = await getVideoSeverityMap();

    const groups = await db.getResolvedAlertGroupsWithMedia({ limit });

    const alerts = groups.map((g) => transformDbAlert(g, severityMap));

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getActiveAlertsAll(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 2000;
    const severityMap = await getVideoSeverityMap();

    const groups = await db.getActiveAlertGroupsAll({ limit });

    const alerts = groups.map((g) => transformDbAlert(g, severityMap));

    res.json({ success: true, alerts, count: alerts.length, total: alerts.length, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertById(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);
    const severityMap = await getVideoSeverityMap();

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
    const severityMap = await getVideoSeverityMap();

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

async function acknowledgeAlert(req, res) {
  res.json({ success: true, alertId: req.params.id, action: 'acknowledge', message: 'EPS read-only: acknowledged locally' });
}

async function resolveAlert(req, res) {
  try {
    const { id } = req.params;
    const { userId, notes, closureType = 'resolved', documents: docData } = req.body || {};

    const updates = { resolved: true, false_alert: closureType === 'false_alert' };
    if (notes) updates.notes = notes;
    const alert = await db.updateAlertStatus(id, updates);

    if (!alert) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    // Also resolve the alert group if it exists
    const group = await db.getAlertGroupByAlertId(id);
    if (group) {
      await db.resolveAlertGroup(group.group_key, { resolved: true, false_alert: closureType === 'false_alert', resolved_by: userId || null, resolved_at: new Date().toISOString(), notes: notes || null });
    }

    const docs = [];
    if (docData) {
      const docEntries = Array.isArray(docData) ? docData : [docData];
      for (const doc of docEntries) {
        if (doc.type && doc.link) {
          docs.push({
            type: doc.type,
            timestamp: doc.timestamp || new Date().toISOString(),
            filled_by: doc.filled_by || userId || 'unknown',
            link: doc.link,
          });
        }
      }
      if (docs.length > 0) {
        await db.addAlertDocument(id, docs);
      }
    }

    res.json({
      success: true,
      alertId: id,
      action: 'close',
      closureType,
      resolved: true,
      false_alert: closureType === 'false_alert',
      documents: docs,
      count: group ? group.count : 1,
      message: group ? `Alert group ${group.group_key} resolved (${group.count} alerts)` : `Alert ${id} resolved successfully`,
    });
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
    const { userId, notes } = req.body || {};

    const alert = await db.updateAlertStatus(id, { resolved: true, false_alert: true });

    if (!alert) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    // Also mark the group as false alert
    const group = await db.getAlertGroupByAlertId(id);
    if (group) {
      await db.resolveAlertGroup(group.group_key, { resolved: true, false_alert: true, resolved_by: userId || null, resolved_at: new Date().toISOString(), notes: notes || null });
    }

    res.json({
      success: true,
      alertId: id,
      action: 'mark-false',
      resolved: true,
      false_alert: true,
      count: group ? group.count : 1,
      message: group ? `Alert group ${group.group_key} marked as false (${group.count} alerts)` : `Alert ${id} marked as false alarm`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function uploadDocumentToAlert(req, res) {
  try {
    const { id } = req.params;
    const { type, filled_by } = req.body;

    if (!type) {
      return res.status(400).json({ success: false, message: 'Document type is required' });
    }

    if (!req.files || !req.files.file) {
      return res.status(400).json({ success: false, message: 'File is required' });
    }

    const file = req.files.file;
    const timestamp = new Date().toISOString();
    const safeName = `${id}_${type}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const publicUrl = await uploadDocument(file.data, safeName, file.mimetype);

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
    const { alertIds, userId, notes, closureType = 'resolved', documents: docData } = req.body || {};
    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return res.status(400).json({ success: false, message: 'alertIds array is required' });
    }

    const results = [];
    for (const id of alertIds) {
      try {
        const updates = { resolved: true, false_alert: closureType === 'false_alert', resolved_at: new Date().toISOString() };
        if (notes) updates.notes = notes;
        const alert = await db.updateAlertStatus(id, updates);
        if (!alert) { results.push({ id, success: false, message: 'Not found' }); continue; }

        const group = await db.getAlertGroupByAlertId(id);
        if (group) {
          await db.resolveAlertGroup(group.group_key, { resolved: true, false_alert: closureType === 'false_alert', resolved_by: userId || null, resolved_at: new Date().toISOString(), notes: notes || null });
        }

        if (docData && docData.length > 0) {
          const docs = docData.map(d => ({ type: d.type, timestamp: d.timestamp || new Date().toISOString(), filled_by: d.filled_by || userId || 'unknown', link: d.link })).filter(d => d.type && d.link);
          if (docs.length > 0) await db.addAlertDocument(id, docs);
        }

        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, message: e.message });
      }
    }

    const resolved = results.filter(r => r.success).length;
    res.json({ success: true, resolved, total: alertIds.length, results, message: `${resolved}/${alertIds.length} alerts resolved` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
  getAlertById,
  getAlertScreenshots,
  getAlertMedia,
  acknowledgeAlert,
  resolveAlert,
  resolveAlertsBulk,
  escalateAlert,
  markFalseAlert,
  uploadDocumentToAlert,
  followUpAlert,
  clearFollowUp,
};
