const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const router = express.Router();

router.post('/history-list', async (req, res) => {
  try {
    const { deviceId, channelId, startTime, endTime } = req.body;
    if (!deviceId || !channelId || !startTime || !endTime) {
      return sendError(res, 'deviceId, channelId, startTime, endTime required', 400);
    }
    const result = await apiClient.makeRequest('/video/history/list', {
      deviceId,
      channelId: Number(channelId),
      startTime,
      endTime,
    });
    if (result.code === 0) {
      sendSuccess(res, { files: result.data || [] }, 'History list retrieved');
    } else {
      sendError(res, result.msg || 'Failed to get history list', 500);
    }
  } catch (error) {
    sendError(res, 'History list failed: ' + error.message, 500);
  }
});

router.post('/history-upload', async (req, res) => {
  try {
    const { deviceId, channelId, startTime, endTime } = req.body;
    if (!deviceId || !channelId || !startTime || !endTime) {
      return sendError(res, 'deviceId, channelId, startTime, endTime required', 400);
    }
    const result = await apiClient.makeRequest('/video/history/upload', {
      deviceId,
      channelId: Number(channelId),
      startTime,
      endTime,
    });
    if (result.code === 0) {
      sendSuccess(res, { taskId: result.data }, 'Upload task created');
    } else {
      sendError(res, result.msg || 'Failed to create upload task', 500);
    }
  } catch (error) {
    sendError(res, 'Upload task failed: ' + error.message, 500);
  }
});

router.post('/history-task', async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) {
      return sendError(res, 'taskId required', 400);
    }
    const result = await apiClient.makeRequest('/video/history/upload/task', {
      taskId: String(taskId),
      pageSize: 10,
      pageIndex: 1,
    });
    if (result.code === 0) {
      sendSuccess(res, result.data, 'Upload task status retrieved');
    } else {
      sendError(res, result.msg || 'Failed to get task status', 500);
    }
  } catch (error) {
    sendError(res, 'Task status failed: ' + error.message, 500);
  }
});

router.post('/history-replay', async (req, res) => {
  try {
    const { deviceId, channelId, startTime, endTime } = req.body;
    if (!deviceId || !channelId || !startTime || !endTime) {
      return sendError(res, 'deviceId, channelId, startTime, endTime required', 400);
    }
    const result = await apiClient.makeRequest('/video/history/replay', {
      deviceId,
      channelId: Number(channelId),
      playbackType: 0,
      fastForwardOrBackward: 0,
      startTime,
      endTime,
    });
    if (result.code === 0 && result.data) {
      sendSuccess(res, { replayUrl: result.data }, 'Replay URL retrieved');
    } else {
      sendError(res, result.msg || 'No replay available', 404);
    }
  } catch (error) {
    sendError(res, 'Replay failed: ' + error.message, 500);
  }
});

router.get('/flv-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return sendError(res, 'url query parameter required', 400);

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
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
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 'FLV proxy failed: ' + error.message, 500);
    }
  }
});

router.get('/download-mp4', async (req, res) => {
  try {
    const { url, duration } = req.query;
    if (!url) return sendError(res, 'url query parameter required', 400);
    const maxDuration = Math.min(Number(duration) || 300, 600);

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    if (response.status < 200 || response.status >= 300) {
      return sendError(res, 'Upstream returned ' + response.status, 502);
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', `attachment; filename="video-${Date.now()}.mp4"`);

    const ffmpeg = spawn('ffmpeg', [
      '-f', 'flv',
      '-i', 'pipe:0',
      '-t', String(maxDuration),
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', 'faststart',
      '-f', 'mp4',
      'pipe:1',
    ]);

    response.data.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);

    let ffmpegError = '';
    ffmpeg.stderr.on('data', (chunk) => { ffmpegError += chunk.toString(); });

    response.data.on('error', () => {
      ffmpeg.kill();
      if (!res.destroyed) res.end();
    });

    ffmpeg.on('error', () => {
      if (!res.headersSent) {
        sendError(res, 'ffmpeg not available', 500);
      }
    });

    ffmpeg.on('close', (code) => {
      if (!res.destroyed) res.end();
      if (code !== 0 && code !== null) {
        console.error('[download-mp4] ffmpeg exited code', code, ffmpegError.slice(-200));
      }
    });

    res.on('close', () => {
      ffmpeg.kill();
      response.data.destroy();
    });
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 'MP4 download failed: ' + error.message, 500);
    }
  }
});

module.exports = router;
