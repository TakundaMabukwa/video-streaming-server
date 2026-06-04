const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const CONCURRENCY = 10;

const getGalleryFiles = async (req, res) => {
  try {
    const now = new Date();
    const defaultEnd = now.toISOString().replace('T', ' ').slice(0, 19);
    const defaultStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const {
      pageSize = 200, pageIndex = 1, deviceIds,
      startTime = defaultStart, endTime = defaultEnd,
      queryType = 'Device', customerId,
    } = req.body;

    if (!deviceIds) return sendError(res, 'deviceIds required', 400);

    const response = await apiClient.makeRequest('/gallery/page/file/v2', {
      pageSize: parseInt(pageSize),
      pageIndex: parseInt(pageIndex),
      deviceIds,
      startTime,
      endTime,
      queryType,
      customerId: customerId || null,
    });

    const records = (response.data?.records || []).filter(r => r.fileType === '00');
    const files = records.map(r => ({
      id: r.id,
      deviceName: r.deviceName,
      deviceId: r.deviceId,
      channelId: r.channelId,
      channelName: r.channelName,
      fileUrl: r.fileUrl,
      fileType: r.fileType,
      fileSize: r.fileSize,
      createTime: r.createTime,
      platform: r.platform,
      captureId: r.captureId,
    }));

    sendSuccess(res, { files, total: response.data?.total || files.length }, 'Gallery files retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const triggerCapture = async (req, res) => {
  try {
    const { captures } = req.body;
    if (!captures || !Array.isArray(captures) || captures.length === 0) {
      return sendError(res, 'captures array required [{deviceId, channelId}]', 400);
    }

    let succeeded = 0;
    let failed = 0;
    const failedDevices = [];

    for (let i = 0; i < captures.length; i += CONCURRENCY) {
      const batch = captures.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(c => apiClient.makeRequest('/gallery/capture', { deviceId: c.deviceId, channelId: c.channelId || 1 }))
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          succeeded++;
        } else {
          failed++;
          failedDevices.push({ deviceId: batch[j].deviceId, channelId: batch[j].channelId, error: results[j].reason?.message });
        }
      }
    }

    if (failed > 0) {
      console.log(`[GALLERY] Captures: ${succeeded} ok, ${failed} failed — ${JSON.stringify(failedDevices.slice(0, 10))}`);
    }

    sendSuccess(res, { requested: captures.length, succeeded, failed, failedDevices: failedDevices.slice(0, 20) }, 'Captures triggered');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getCapturePage = async (req, res) => {
  try {
    const now = new Date();
    const defaultEnd = now.toISOString().replace('T', ' ').slice(0, 19);
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const { pageSize = 50, pageIndex = 1, deviceIds, startTime = defaultStart, endTime = defaultEnd, status } = req.body;

    const payload = { pageSize: parseInt(pageSize), pageIndex: parseInt(pageIndex), startTime, endTime };
    if (deviceIds) payload.deviceIds = deviceIds;
    if (status !== undefined) payload.status = parseInt(status);

    const response = await apiClient.makeRequest('/gallery/capture/page', payload);

    const records = (response.data?.records || []).map(r => ({
      id: r.id,
      platform: r.platform,
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      channelId: r.channelId,
      status: r.status,
      createTime: r.createTime,
      channelName: r.channelName,
    }));

    sendSuccess(res, { records, total: response.data?.total || records.length }, 'Capture page retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

module.exports = { getGalleryFiles, triggerCapture, getCapturePage };
