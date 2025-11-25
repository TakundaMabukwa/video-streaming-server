const express = require('express');
const { getDevices, getLiveStream, controlStream, getCustomerTree, getDeviceShadow, getDeviceByName, getStreamByPlate, getAllDevicesNetwork } = require('../controllers/streamController');

const router = express.Router();

router.post('/devices', getDevices);
router.post('/live', getLiveStream);
router.post('/control', controlStream);
router.post('/customers', getCustomerTree);
router.post('/shadow', getDeviceShadow);
router.post('/device/name', getDeviceByName);
router.post('/live/plate', getStreamByPlate);
router.get('/network', getAllDevicesNetwork);

module.exports = router;