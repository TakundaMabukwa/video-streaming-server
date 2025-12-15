const express = require('express');
const axios = require('axios');
const { getDevices, getLiveStream, controlStream, getCustomerTree, getDeviceShadow, getDeviceByName, getStreamByPlate, getAllDevicesNetwork, getOnlineDevices, getAllVehiclesWithStreams } = require('../controllers/streamController');
const { sendSuccess, sendError } = require('../helpers/response');

const router = express.Router();

router.post('/devices', getDevices);
router.post('/live', getLiveStream);
router.post('/control', controlStream);
router.post('/customers', getCustomerTree);
router.post('/shadow', getDeviceShadow);
router.post('/device/name', getDeviceByName);
router.post('/live/plate', getStreamByPlate);
router.get('/network', getAllDevicesNetwork);
router.post('/online', getOnlineDevices);
router.post('/vehicles/streams', getAllVehiclesWithStreams);

const activeStreams = new Map();

router.get('/stream/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return sendError(res, 'Stream URL required', 400);
    }

    // Set headers for persistent connection
    res.setHeader('Content-Type', 'video/x-flv');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const streamKey = Buffer.from(url).toString('base64');
    
    // Reuse existing stream if available
    if (activeStreams.has(streamKey)) {
      const existingStream = activeStreams.get(streamKey);
      existingStream.pipe(res);
      return;
    }

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'Connection': 'keep-alive',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    // Store stream for reuse
    activeStreams.set(streamKey, response.data);
    
    response.data.pipe(res);
    
    // Clean up on stream end
    response.data.on('end', () => {
      activeStreams.delete(streamKey);
    });
    
    response.data.on('error', () => {
      activeStreams.delete(streamKey);
    });
    
  } catch (error) {
    sendError(res, 'Failed to stream: ' + error.message, 500);
  }
});

module.exports = router;
