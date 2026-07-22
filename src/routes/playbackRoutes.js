const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

router.get('/stream-mp4', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return sendError(res, 'url query parameter required', 400);

    console.log('[stream-mp4] Starting ffmpeg for', url.slice(0, 80));

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-headers', `User-Agent: Mozilla/5.0\r\n`,
      '-i', url,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-t', '120',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      'pipe:1',
    ]);

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {});

    let ffmpegError = false;
    ffmpeg.on('error', (err) => {
      ffmpegError = true;
      console.error('[stream-mp4] ffmpeg error:', err.message);
      if (!res.destroyed) res.end();
    });
    ffmpeg.on('close', (code) => {
      console.log('[stream-mp4] ffmpeg exited:', code);
      if (!res.destroyed) res.end();
    });

    res.on('close', () => {
      ffmpeg.kill('SIGTERM');
    });
  } catch (error) {
    if (!res.headersSent) {
      console.error('[stream-mp4] Error:', error.message);
      sendError(res, 'Stream MP4 failed: ' + error.message, 500);
    }
  }
});

router.get('/image-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return sendError(res, 'url query parameter required', 400);

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    if (response.status < 200 || response.status >= 300) {
      return sendError(res, 'Upstream returned ' + response.status, 502);
    }

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    response.data.pipe(res);
    response.data.on('error', () => { if (!res.destroyed) res.end(); });
    res.on('close', () => response.data.destroy());
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 'Image proxy failed: ' + error.message, 500);
    }
  }
});

router.get('/download-mp4', async (req, res) => {
  const tmpFlv = path.join(os.tmpdir(), `dl-${Date.now()}.flv`);
  const tmpMp4 = path.join(os.tmpdir(), `dl-${Date.now()}.mp4`);
  try {
    const { url, duration } = req.query;
    if (!url) return sendError(res, 'url query parameter required', 400);
    const maxDuration = Math.min(Number(duration) || 300, 600);

    console.log('[download-mp4] Starting download from', url.slice(0, 80));

    // Download FLV to temp file first
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    if (response.status < 200 || response.status >= 300) {
      return sendError(res, 'Upstream returned ' + response.status, 502);
    }

    const writer = fs.createWriteStream(tmpFlv);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });

    const flvSize = fs.statSync(tmpFlv).size;
    console.log('[download-mp4] FLV downloaded:', flvSize, 'bytes');

    if (flvSize === 0) {
      return sendError(res, 'No data received from upstream', 502);
    }

    // Convert FLV to MP4 with ffmpeg
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', tmpFlv,
        '-t', String(maxDuration),
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-movflags', 'faststart',
        tmpMp4,
      ]);

      let ffmpegError = '';
      ffmpeg.stderr.on('data', (chunk) => { ffmpegError += chunk.toString(); });

      ffmpeg.on('error', (err) => reject(err));

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          console.error('[download-mp4] ffmpeg exited code', code, ffmpegError.slice(-500));
          reject(new Error(`ffmpeg failed with code ${code}`));
        }
      });
    });

    const mp4Size = fs.statSync(tmpMp4).size;
    console.log('[download-mp4] MP4 converted:', mp4Size, 'bytes');

    if (mp4Size === 0) {
      return sendError(res, 'Conversion produced empty file', 500);
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', `attachment; filename="video-${Date.now()}.mp4"`);
    res.setHeader('Content-Length', mp4Size);

    const readStream = fs.createReadStream(tmpMp4);
    readStream.pipe(res);
    readStream.on('end', () => {
      fs.unlink(tmpFlv, () => {});
      fs.unlink(tmpMp4, () => {});
    });
    readStream.on('error', () => {
      fs.unlink(tmpFlv, () => {});
      fs.unlink(tmpMp4, () => {});
      if (!res.destroyed) res.end();
    });

    res.on('close', () => {
      readStream.destroy();
      fs.unlink(tmpFlv, () => {});
      fs.unlink(tmpMp4, () => {});
    });
  } catch (error) {
    fs.unlink(tmpFlv, () => {});
    fs.unlink(tmpMp4, () => {});
    if (!res.headersSent) {
      console.error('[download-mp4] Error:', error.message);
      sendError(res, 'MP4 download failed: ' + error.message, 500);
    }
  }
});

module.exports = router;
