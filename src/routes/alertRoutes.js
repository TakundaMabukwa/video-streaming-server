const express = require('express');
const { getAlertTypes, getAlarmPage, getAlertFeed, getAlarmFilesById, getAlarmFilesByPage, getDevices } = require('../controllers/alertController');
const { getActiveAlerts, getResolvedAlerts, getAlertById, getAlertScreenshots, getAlertMedia, acknowledgeAlert, resolveAlert, escalateAlert, markFalseAlert, uploadDocumentToAlert } = require('../controllers/dbAlertController');

const router = express.Router();

router.get('/types', getAlertTypes);
router.post('/page', getAlarmPage);
router.get('/feed', getAlertFeed);
router.get('/files/:alarmId', getAlarmFilesById);
router.post('/files/page', getAlarmFilesByPage);
router.get('/devices', getDevices);

router.get('/active', getActiveAlerts);
router.get('/resolved', getResolvedAlerts);
router.get('/:id/screenshots', getAlertScreenshots);
router.get('/:id/media', getAlertMedia);
router.post('/:id/acknowledge', acknowledgeAlert);
router.post('/:id/close', resolveAlert);
router.post('/:id/escalate', escalateAlert);
router.post('/:id/mark-false', markFalseAlert);
router.post('/:id/documents', uploadDocumentToAlert);
router.get('/:id', getAlertById);

module.exports = router;
