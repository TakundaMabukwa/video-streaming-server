const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const getDevices = async (req, res) => {
  try {
    const { customerId, pageIndex = 1 } = req.body;
    
    const response = await apiClient.makeRequest('/device/page', {
      pageIndex,
      pageSize: 100,
      customerId,
      subsumption: true
    });

    if (response.code === 0) {
      sendSuccess(res, response.data, 'Devices retrieved successfully');
    } else {
      sendError(res, response.msg || 'Failed to get devices', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getLiveStream = async (req, res) => {
  try {
    const { deviceId, channelId = 1, bitstreamType = 1, nodeValue } = req.body;

    if (!deviceId) {
      return sendError(res, 'Device ID is required', 400);
    }

    const response = await apiClient.makeRequest('/video/live', {
      deviceId,
      channelId,
      bitstreamType,
      nodeValue
    });

    if (response.code === 0) {
      sendSuccess(res, { streamUrl: response.data }, 'Live stream URL retrieved');
    } else {
      sendError(res, response.msg || 'Failed to get live stream', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const controlStream = async (req, res) => {
  try {
    const { deviceId, channelId, bitstreamType } = req.body;

    if (!deviceId || channelId === undefined || bitstreamType === undefined) {
      return sendError(res, 'Device ID, channel ID, and bitstream type are required', 400);
    }

    const response = await apiClient.makeRequest('/video/live/control', {
      deviceId,
      channelId,
      bitstreamType
    });

    if (response.code === 0) {
      sendSuccess(res, response.data, 'Stream control executed successfully');
    } else {
      sendError(res, response.msg || 'Stream control failed', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getCustomerTree = async (req, res) => {
  try {
    const { customerId } = req.body;
    
    const response = await apiClient.makeRequest('/customer/tree', {
      customerId: customerId || null
    });

    if (response.code === 0) {
      sendSuccess(res, response.data, 'Customer tree retrieved successfully');
    } else {
      sendError(res, response.msg || 'Failed to get customer tree', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getDeviceShadow = async (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return sendError(res, 'Customer ID is required', 400);
    }

    const response = await apiClient.makeRequest('/device/shadow/customer', {
      customerId
    });

    if (response.code === 0) {
      sendSuccess(res, response.data, 'Device shadow data retrieved successfully');
    } else {
      sendError(res, response.msg || 'Failed to get device shadow data', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getDeviceByName = async (req, res) => {
  try {
    const { deviceName } = req.body;

    if (!deviceName) {
      return sendError(res, 'Device name is required', 400);
    }

    const response = await apiClient.makeRequest('/device/page', {
      pageIndex: 1,
      pageSize: 100,
      deviceName: deviceName,
      subsumption: true
    });

    if (response.code === 0) {
      const device = response.data.records.find(d => d.deviceName === deviceName);
      if (device) {
        sendSuccess(res, device, 'Device found successfully');
      } else {
        sendError(res, 'Device not found', 404);
      }
    } else {
      sendError(res, response.msg || 'Failed to search device', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getStreamByPlate = async (req, res) => {
  try {
    const { plateName, channelId = 1, bitstreamType = 1 } = req.body;

    if (!plateName) {
      return sendError(res, 'Plate name is required', 400);
    }

    // First find device by plate name
    const deviceResponse = await apiClient.makeRequest('/device/page', {
      pageIndex: 1,
      pageSize: 100,
      deviceName: plateName,
      subsumption: true
    });

    if (deviceResponse.code !== 0) {
      return sendError(res, 'Failed to find device', 400);
    }

    const device = deviceResponse.data.records.find(d => d.deviceName === plateName);
    if (!device) {
      return sendError(res, 'Vehicle with plate not found', 404);
    }

    // Get stream for the device
    const streamResponse = await apiClient.makeRequest('/video/live', {
      deviceId: device.id,
      channelId,
      bitstreamType
    });

    if (streamResponse.code === 0) {
      sendSuccess(res, {
        plateName: device.deviceName,
        deviceId: device.id,
        streamUrl: streamResponse.data,
        camCount: device.camCount
      }, 'Stream URL retrieved by plate');
    } else {
      sendError(res, streamResponse.msg || 'Failed to get stream', 400);
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getAllDevicesNetwork = async (req, res) => {
  try {
    // Get all devices with pagination
    const allDevices = [];
    let pageIndex = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await apiClient.makeRequest('/device/page', {
        pageIndex,
        pageSize: 100,
        subsumption: true
      });

      if (response.code === 0 && response.data.records.length > 0) {
        allDevices.push(...response.data.records);
        pageIndex++;
        hasMore = response.data.records.length === 100;
      } else {
        hasMore = false;
      }
    }

    // Get customer info
    const customerResponse = await apiClient.makeRequest('/customer/tree', {
      customerId: null
    });

    const networkInfo = {
      totalDevices: allDevices.length,
      customer: customerResponse.code === 0 ? customerResponse.data[0] : null,
      devices: allDevices.map(device => ({
        plateName: device.deviceName,
        deviceId: device.id,
        deviceType: device.deviceType,
        cameras: device.camCount,
        activeTime: device.activeTime,
        expirationTime: device.expirationTime,
        timezone: device.timezone,
        customerName: device.customerName
      })),
      deviceTypes: [...new Set(allDevices.map(d => d.deviceType))],
      totalCameras: allDevices.reduce((sum, d) => sum + d.camCount, 0)
    };

    sendSuccess(res, networkInfo, 'Network devices retrieved successfully');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

module.exports = {
  getDevices,
  getLiveStream,
  controlStream,
  getCustomerTree,
  getDeviceShadow,
  getDeviceByName,
  getStreamByPlate,
  getAllDevicesNetwork
};