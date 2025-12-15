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
    const { deviceId, channelId = 1, bitstreamType = 1, nodeValue = null } = req.body;

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
      if (deviceResponse.msg && deviceResponse.msg.includes('call count exceeds')) {
        return sendError(res, 'API rate limit exceeded. Please try again in a few minutes.', 429);
      }
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
      bitstreamType,
      nodeValue: null
    });

    if (streamResponse.code === 0) {
      sendSuccess(res, {
        plateName: device.deviceName,
        deviceId: device.id,
        streamUrl: streamResponse.data,
        camCount: device.camCount
      }, 'Stream URL retrieved by plate');
    } else {
      if (streamResponse.msg && streamResponse.msg.includes('call count exceeds')) {
        return sendError(res, 'API rate limit exceeded. Please try again in a few minutes.', 429);
      }
      sendError(res, streamResponse.msg || 'Failed to get stream', 400);
    }
  } catch (error) {
    if (error.message.includes('call count exceeds')) {
      return sendError(res, 'API rate limit exceeded. Please try again in a few minutes.', 429);
    }
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

const getOnlineDevices = async (req, res) => {
  try {
    const { customerId } = req.body;

    // Get device shadow data to check online status
    const shadowResponse = await apiClient.makeRequest('/device/shadow/customer', {
      customerId: customerId || null
    });

    if (shadowResponse.code !== 0) {
      return sendError(res, 'Failed to get device status', 400);
    }

    // Filter only online devices
    const onlineDevices = shadowResponse.data.filter(device => device.online === true);

    const result = {
      totalOnline: onlineDevices.length,
      devices: onlineDevices.map(device => ({
        plateName: device.deviceName,
        deviceId: device.deviceId,
        online: device.online,
        lastSeen: device.lastActiveTime,
        cameras: device.camCount || 0
      }))
    };

    sendSuccess(res, result, 'Online devices retrieved successfully');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getAllVehiclesWithStreams = async (req, res) => {
  try {
    const { bitstreamType = 1, timeout = 5000, onlineOnly = false, allChannels = false } = req.body;

    // Get all devices
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

    // Process all devices
    const vehiclesWithStreams = await Promise.allSettled(
      allDevices.map(async (device) => {
        if (allChannels) {
          // Get streams for all channels
          const channels = [];
          for (let channelId = 1; channelId <= device.camCount; channelId++) {
            try {
              const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('timeout')), timeout)
              );
              
              const streamPromise = apiClient.makeRequest('/video/live', {
                deviceId: device.id,
                channelId,
                bitstreamType,
                nodeValue: null
              });

              const streamResponse = await Promise.race([streamPromise, timeoutPromise]);
              if (streamResponse.code === 0 && streamResponse.data) {
                channels.push({
                  channelId,
                  streamUrl: streamResponse.data
                });
              }
            } catch (error) {
              // Skip failed channels
            }
          }
          
          const vehicle = {
            plateName: device.deviceName,
            deviceId: device.id,
            channels,
            cameras: device.camCount,
            deviceType: device.deviceType,
            customerName: device.customerName
          };
          
          if (onlineOnly && channels.length === 0) return null;
          return vehicle;
        } else {
          // Get only first channel (original behavior)
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), timeout)
          );
          
          const streamPromise = apiClient.makeRequest('/video/live', {
            deviceId: device.id,
            channelId: 1,
            bitstreamType,
            nodeValue: null
          });

          try {
            const streamResponse = await Promise.race([streamPromise, timeoutPromise]);
            const hasStream = streamResponse.code === 0 && streamResponse.data;
            
            const vehicle = {
              plateName: device.deviceName,
              deviceId: device.id,
              streamUrl: hasStream ? streamResponse.data : null,
              cameras: device.camCount,
              deviceType: device.deviceType,
              customerName: device.customerName
            };
            
            if (onlineOnly && !hasStream) return null;
            return vehicle;
          } catch (error) {
            const vehicle = {
              plateName: device.deviceName,
              deviceId: device.id,
              streamUrl: null,
              cameras: device.camCount,
              deviceType: device.deviceType,
              customerName: device.customerName
            };
            
            if (onlineOnly) return null;
            return vehicle;
          }
        }
      })
    );

    const validVehicles = vehiclesWithStreams
      .map(result => result.status === 'fulfilled' ? result.value : null)
      .filter(vehicle => vehicle !== null);

    const result = {
      totalVehicles: validVehicles.length,
      vehicles: validVehicles
    };

    sendSuccess(res, result, 'All vehicles with streams retrieved successfully');
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
  getAllDevicesNetwork,
  getOnlineDevices,
  getAllVehiclesWithStreams
};