const express = require('express');
const axios = require('axios');
const apiClient = require('../helpers/apiClient');
const { getDevices, getLiveStream, controlStream, getCustomerTree, getDeviceShadow, getDeviceByName, getStreamByPlate, getAllDevicesNetwork, getOnlineDevices, getAllVehiclesWithStreams } = require('../controllers/streamController');
const { debugVehicleStreams } = require('../controllers/debugController');
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
router.post('/debug/vehicle', debugVehicleStreams);

router.post('/replay', async (req, res) => {
  try {
    const { deviceId, channelId, startTime, endTime } = req.body;
    if (!deviceId || !channelId || !startTime || !endTime) {
      return sendError(res, 'deviceId, channelId, startTime, endTime required', 400);
    }
    const replayUrl = await apiClient.makeRequest('/video/history/replay', {
      deviceId,
      channelId,
      playbackType: 0,
      fastForwardOrBackward: 0,
      startTime,
      endTime,
    });
    if (replayUrl.code === 0 && replayUrl.data) {
      sendSuccess(res, { replayUrl: replayUrl.data }, 'Replay URL retrieved');
    } else {
      sendError(res, replayUrl.msg || 'No replay available', 404);
    }
  } catch (error) {
    sendError(res, 'Replay failed: ' + error.message, 500);
  }
});

router.get('/nodes', async (req, res) => {
  try {
    const nodes = await apiClient.getLiveNodes();
    sendSuccess(res, { nodes }, 'Live nodes retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
});

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.flv': 'video/x-flv',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

router.get('/stream/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return sendError(res, 'Stream URL required', 400);
    }

    const ext = (url.match(/\.(\w+)(?:\?|$)/) || [])[0]?.toLowerCase() || '';
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    const isStream = mime === 'video/x-flv';

    if (isStream) {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (response.status < 200 || response.status >= 300) {
        return sendError(res, 'Upstream returned ' + response.status, 502);
      }

      res.setHeader('Content-Type', 'video/x-flv');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      response.data.pipe(res);
      response.data.on('error', () => { if (!res.destroyed) res.end(); });
      res.on('close', () => response.data.destroy());
    } else {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        return sendError(res, 'Upstream returned ' + response.status, 502);
      }

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');

      response.data.pipe(res);
    }
  } catch (error) {
    sendError(res, 'Failed to stream: ' + error.message, 500);
  }
});

module.exports = router;
