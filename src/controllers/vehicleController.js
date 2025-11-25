const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const getDeviceInfo = async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return sendError(res, 'Device ID is required', 400);
    }

    // Try to get extended device information
    const response = await apiClient.makeRequest('/device/info', {
      deviceId
    });

    if (response.code === 0) {
      sendSuccess(res, response.data, 'Device info retrieved successfully');
    } else {
      sendError(res, response.msg || 'Failed to get device info', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getVehicleInfo = async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return sendError(res, 'Device ID is required', 400);
    }

    // Try vehicle-specific endpoint
    const response = await apiClient.makeRequest('/vehicle/info', {
      deviceId
    });

    if (response.code === 0) {
      sendSuccess(res, response.data, 'Vehicle info retrieved successfully');
    } else {
      sendError(res, response.msg || 'Failed to get vehicle info', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

module.exports = {
  getDeviceInfo,
  getVehicleInfo
};