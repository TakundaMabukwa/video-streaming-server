const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const debugVehicleStreams = async (req, res) => {
  try {
    const { deviceId, plateName } = req.body;

    if (!deviceId && !plateName) {
      return sendError(res, 'Device ID or plate name required', 400);
    }

    const id = deviceId || plateName;

    // Try channels 1-2 directly (most devices only have 2 cameras)
    const channelTests = [];
    for (let channelId = 1; channelId <= 2; channelId++) {
      try {
        const streamResponse = await apiClient.makeRequest('/video/live', {
          deviceId: id,
          channelId,
          bitstreamType: 1,
        }, 10000);

        channelTests.push({
          channelId,
          success: streamResponse.code === 0 && !!streamResponse.data,
          streamUrl: streamResponse.data || null,
          message: streamResponse.code === 0 ? 'OK' : (streamResponse.msg || 'Stream not available')
        });
      } catch (error) {
        const msg = error.message || 'Connection failed';
        channelTests.push({
          channelId,
          success: false,
          streamUrl: null,
          message: msg.includes('timed out') ? 'Device not responding' : msg.includes('Network') ? 'Network error' : msg
        });
      }
    }

    const result = {
      device: { deviceId: id },
      channels: channelTests,
      successCount: channelTests.filter(c => c.success).length
    };

    sendSuccess(res, result, 'Debug test completed');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

module.exports = {
  debugVehicleStreams
};
