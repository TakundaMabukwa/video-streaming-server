const express = require('express');
const {
  getAlertsList,
  getAlertDetail,
  triggerSync,
  getSyncStatus,
  getDevices,
  getAlertTypes,
} = require('../controllers/dbAlertController');

const router = express.Router();

router.get('/list', getAlertsList);
router.get('/detail/:alertId', getAlertDetail);
router.post('/sync', triggerSync);
router.get('/status', getSyncStatus);
router.get('/devices', getDevices);
router.get('/types', getAlertTypes);

module.exports = router;
