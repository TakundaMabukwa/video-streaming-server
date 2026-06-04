const db = require('../db');
const syncService = require('../services/syncService');
const { sendSuccess, sendError } = require('../helpers/response');
const { uploadDocument } = require('../helpers/storage');
const { transformDbAlert } = require('../helpers/transform');

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
    sendSuccess(res, { ...status, stats }, 'Sync status retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function getDevices(req, res) {
  try {
    const result = await db.query(
      `SELECT device_id, device_name, COUNT(*) as alert_count,
       MAX(alarm_ts) as last_alert_ts
       FROM alerts
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
      `SELECT alarm_type, COUNT(*) as alert_count
       FROM alerts
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

    const dbResult = await db.getActiveAlertsWithMedia({ pageSize: limit, pageIndex: 1 });

    const alerts = dbResult.records.map(transformDbAlert);

    res.json({ success: true, alerts, count: alerts.length, total: dbResult.total, source: 'eps-db' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertById(req, res) {
  try {
    const { id } = req.params;
    if (!id) return sendError(res, 'Alert ID required', 400);

    const alert = await db.getAlertWithMedia(id);
    if (!alert) {
      return res.status(404).json({ success: false, message: `Alert ${id} not found` });
    }

    const transformed = transformDbAlert(alert);
    transformed.screenshots = (alert.media || []).map((m, i) => ({
      id: m.id || `media-${i}`,
      url: m.file_url,
      storage_url: m.file_url,
      timestamp: m.created_at,
    }));
    transformed.videos = [];

    const entries = (alert.media || [])
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

    const alert = await db.getAlertWithMedia(id);
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
    if (!id) return sendError(res, 'Alert ID required', 400);

    const alert = await db.getAlertWithMedia(id);
    if (!alert) {
      return res.json({ success: true, alert: null, screenshots: [], videos: [], captures: [], clipUrls: {}, source: 'eps-db' });
    }

    const transformed = transformDbAlert(alert);
    const media = alert.media || [];
    const images = media.filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01');
    const videoFiles = media.filter((m) => m.file_type === '02');

    const screenshots = images.map((m, i) => ({
      id: m.id || `shot-${i}`,
      url: m.file_url,
      storage_url: m.file_url,
      timestamp: m.created_at || m.alarm_time,
    }));

    const entries = videoFiles.map((m) => ({
      id: m.id,
      label: 'Alert Media',
      url: m.file_url,
      fileUrl: m.file_url,
      timestamp: m.created_at || m.alarm_time,
    }));

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
      message: `Alert ${id} resolved successfully`,
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

    res.json({
      success: true,
      alertId: id,
      action: 'mark-false',
      resolved: true,
      false_alert: true,
      message: `Alert ${id} marked as false alarm`,
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

module.exports = {
  getAlertsList,
  getAlertDetail,
  triggerSync,
  getSyncStatus,
  getDevices,
  getAlertTypes,
  getActiveAlerts,
  getAlertById,
  getAlertScreenshots,
  getAlertMedia,
  acknowledgeAlert,
  resolveAlert,
  escalateAlert,
  markFalseAlert,
  uploadDocumentToAlert,
};
