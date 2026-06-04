const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const debugVehicleStreams = async (req, res) => {
  try {
    const { deviceId, plateName } = req.body;

    if (!deviceId && !plateName) {
      return sendError(res, 'Device ID or plate name required', 400);
    }

    // Get device info
    let device = null;
    if (deviceId) {
      const response = await apiClient.makeRequest('/device/page', {
        pageIndex: 1,
        pageSize: 100,
        subsumption: true
      });
      device = response.data.records.find(d => d.id === deviceId);
    } else {
      const response = await apiClient.makeRequest('/device/page', {
        pageIndex: 1,
        pageSize: 100,
        deviceName: plateName,
        subsumption: true
      });
      device = response.data.records.find(d => d.deviceName === plateName);
    }

    if (!device) {
      return sendError(res, 'Device not found', 404);
    }

    // Test up to 2 channels
    const channelTests = [];
    for (let channelId = 1; channelId <= Math.min(device.camCount, 2); channelId++) {
      try {
        const streamResponse = await apiClient.tryNodesForStream(device.id, channelId, 1);

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
      device: {
        plateName: device.deviceName,
        deviceId: device.id,
        cameras: device.camCount
      },
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
