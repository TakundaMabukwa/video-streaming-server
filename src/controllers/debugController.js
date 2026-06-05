const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const debugVehicleStreams = async (req, res) => {
  try {
    const { deviceId, plateName } = req.body;

    if (!deviceId && !plateName) {
      return sendError(res, 'Device ID or plate name required', 400);
    }

    const id = deviceId || plateName;

    // Try channels 1 and 2 directly — no device page lookup needed
    const channelTests = [];
    for (let channelId = 1; channelId <= 2; channelId++) {
      try {
        const streamResponse = await apiClient.tryNodesForStream(id, channelId, 1);

        channelTests.push({
          channelId,
          success: streamResponse.code === 0,
          streamUrl: streamResponse.data || null,
          message: streamResponse.msg || 'OK'
        });
      } catch (error) {
        channelTests.push({
          channelId,
          success: false,
          error: error.message
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
