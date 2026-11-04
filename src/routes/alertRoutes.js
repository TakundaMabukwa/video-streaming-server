const express = require('express');
const rateLimit = require('express-rate-limit');
const { getAlertTypes, getAlarmPage, getAlertFeed, getAlarmFilesById, getAlarmFilesByPage, getDevices } = require('../controllers/alertController');
const { getActiveAlerts, getActiveAlertsAll, getActivePerVehicleAlerts, getActiveAlertCounts, getClosedSummaryByCC, getResolvedAlerts, getResolvedAlertCount, getClosedAlertsCountQuery, getAlertById, getAlertScreenshots, getAlertMedia, getAlertMembers, acknowledgeAlert, resolveAlert, escalateAlert, markFalseAlert, uploadDocumentToAlert, followUpAlert, clearFollowUp, getAlertHistory, listAlerts, watchAlert, unwatchAlert, getAlertWatchers, getAllWatchers, getActiveCooldowns } = require('../controllers/dbAlertController');
const db = require('../db');
const apiClient = require('../helpers/apiClient');
const { getAlertSnapshot, streamAlerts } = require('../controllers/liveController');
const { getAlertGroupDetail, getOpenAlertsByFleet, getAlertGroupMembers, getAlertOccurrenceDetail, resolveAlerts } = require('../controllers/alertCenterController');

const router = express.Router();

const { resolveAlertsBulk } = require('../controllers/dbAlertController');

// Live board pipeline
router.get('/snapshot', getAlertSnapshot);
router.get('/stream', streamAlerts);

router.get('/types', getAlertTypes);
router.post('/page', getAlarmPage);
router.get('/feed', getAlertFeed);
router.get('/files/:alarmId', getAlarmFilesById);
router.post('/files/page', getAlarmFilesByPage);
router.get('/devices', getDevices);

router.get('/groups/:id', getAlertGroupDetail);
router.get('/open', getOpenAlertsByFleet);
router.get('/groups/:id/members', getAlertGroupMembers);
router.get('/occurrences/:id', getAlertOccurrenceDetail);

router.get('/active', getActiveAlerts);
router.get('/active-per-vehicle', getActivePerVehicleAlerts);
router.get('/summary-by-cost-center', getClosedSummaryByCC);
router.get('/active-all', getActiveAlertsAll);
router.get('/active-counts', getActiveAlertCounts);
router.get('/resolved', getResolvedAlerts);
router.get('/resolved-count', getResolvedAlertCount);
// Reports summary cards: closed alerts for the current cost-centre selection.
// Registered before /:id so "closed-count" is never read as an alert id.
router.get('/closed-count', getClosedAlertsCountQuery);
// Active cooldown timers (device_id= required, alarm_type= optional).
// Registered before /:id so "cooldowns" is never read as an alert id.
router.get('/cooldowns', getActiveCooldowns);
router.get('/history', getAlertHistory);
// GET /alerts?status=new|active|resolved|closed&limit=&offset= — previously fell
// through to the catch-all below and always answered with an empty list.
router.get('/', listAlerts);
// Bulk resolve is the most destructive user action — tighter than the global limiter.
const bulkCloseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many bulk-close requests, please try again later.' },
});
router.post('/bulk-close', bulkCloseLimiter, resolveAlertsBulk);
router.post('/resolve', bulkCloseLimiter, resolveAlerts);
router.get('/:id/screenshots', getAlertScreenshots);
router.get('/:id/media', getAlertMedia);
router.get('/:id/members', getAlertMembers);
router.post('/:id/capture', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'Alert ID required' });

    let group = null;
    let alertId = id;
    const asGroupPk = Number(id);
    if (Number.isInteger(asGroupPk) && asGroupPk >= 1 && String(asGroupPk) === String(String(id).trim())) {
      group = await db.getAlertGroupById(asGroupPk);
    }
    if (!group) group = await db.getAlertGroupByAlertId(id);
    if (group) alertId = group.last_alert_id;
    const alert = await db.getAlertWithMedia(alertId);
    if (!alert) return res.status(404).json({ success: false, message: 'Alert not found' });

    const devId = alert.deviceId || alert.device_id || '';
    if (!devId) return res.status(400).json({ success: false, message: 'No device ID on this alert' });

    const results = await Promise.allSettled([
      apiClient.makeRequest('/gallery/capture', { deviceId: devId, channelId: 1 }),
      apiClient.makeRequest('/gallery/capture', { deviceId: devId, channelId: 2 }),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    res.json({ success: true, requested: 2, succeeded, deviceId: devId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get('/watchers', getAllWatchers);
router.post('/:id/watch', watchAlert);
router.delete('/:id/watch', unwatchAlert);
router.get('/:id/watchers', getAlertWatchers);
router.post('/:id/acknowledge', acknowledgeAlert);
router.post('/:id/close', resolveAlert);
router.post('/:id/escalate', escalateAlert);
router.post('/:id/mark-false', markFalseAlert);
router.post('/:id/follow-up', followUpAlert);
router.post('/:id/clear-follow-up', clearFollowUp);
router.post('/:id/documents', uploadDocumentToAlert);
router.get('/:id', getAlertById);

// Catch-all for any other GET /alerts/* paths — return empty
router.get('*', (req, res) => {
  res.json({ success: true, alerts: [], count: 0, total: 0, source: 'eps-db' });
});

module.exports = router;
