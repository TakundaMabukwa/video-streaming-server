const apiClient = require('../helpers/apiClient');
const { sendSuccess, sendError } = require('../helpers/response');

const ALERT_TYPE_MAP = {
  fatigueWarn: { display: 'Fatigue', icon: 'alert-triangle' },
  fatigueAlarm: { display: 'Fatigue', icon: 'alert-triangle' },
  handheldPhoneCall: { display: 'Cellphone', icon: 'smartphone' },
  seatBelt: { display: 'Seatbelt', icon: 'user' },
  laneShift: { display: 'Lane deviation', icon: 'arrow-left-right' },
  closeProximity: { display: 'Tailgating', icon: 'car' },
  bang: { display: 'Crash', icon: 'car-crash' },
  hardBraking: { display: 'Rollover', icon: 'car-crash' },
  driverNotDetected: { display: 'Driver not in view of camera', icon: 'user-x' },
  forwardCollisionWarning: { display: 'Forward collision', icon: 'car-front' },
  pedestrianBang: { display: 'Pedestrian collision', icon: 'person-running' },
  overtime: { display: 'Driving longer than 3 hours', icon: 'clock' },
  speed: { display: 'Overspeeding Over 90kph', icon: 'gauge' },
  powerCut: { display: 'Battery Disconnection', icon: 'battery-warning' },
  occlusion: { display: 'Camera occlusion', icon: 'camera-off' },
  sos: { display: 'Panic Alert', icon: 'bell-ring' },
};

const ALERT_TYPE_LIST = Object.keys(ALERT_TYPE_MAP);

const getAlertTypes = async (req, res) => {
  try {
    const response = await apiClient.makeRequest('/alarm/type/list', {});
    sendSuccess(res, response.data || response, 'Alert types retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

let deviceIdsCache = null;
let deviceIdsCacheTime = 0;
const DEVICE_IDS_TTL = 30000;

const getAllDeviceIds = async () => {
  const now = Date.now();
  if (deviceIdsCache && (now - deviceIdsCacheTime) < DEVICE_IDS_TTL) {
    return deviceIdsCache;
  }
  const allDevices = [];
  let pageIndex = 1;
  let hasMore = true;
  while (hasMore) {
    const response = await apiClient.makeRequest('/device/page', {
      pageIndex, pageSize: 100, subsumption: true,
    });
    if (response.code === 0 && response.data.records.length > 0) {
      allDevices.push(...response.data.records.map(d => d.id));
      pageIndex++;
      hasMore = response.data.records.length === 100;
    } else {
      hasMore = false;
    }
  }
  deviceIdsCache = allDevices;
  deviceIdsCacheTime = now;
  return allDevices;
};

const getAlarmPage = async (req, res) => {
  try {
    const now = new Date();
    const defaultEnd = now.toISOString().replace('T', ' ').slice(0, 19);
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const {
      pageSize = 50, pageIndex = 1, deviceIds, alarmType,
      startTime = defaultStart, endTime = defaultEnd,
    } = req.body;

    const ids = deviceIds || (await getAllDeviceIds()).join(',');

    const response = await apiClient.makeRequest('/alarm/alarmPage', {
      pageSize: parseInt(pageSize),
      pageIndex: parseInt(pageIndex),
      deviceIds: ids,
      alarmType: alarmType || null,
      startTime,
      endTime,
    });

    sendSuccess(res, response.data || response, 'Alarms retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getAlertFeed = async (req, res) => {
  try {
    const { pageSize = 50, pageIndex = 1, startTime, endTime } = req.query;

    const now = new Date();
    const defaultEnd = now.toISOString().replace('T', ' ').slice(0, 19);
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const deviceIds = (await getAllDeviceIds()).join(',');

    if (!deviceIds) {
      return sendSuccess(res, { alerts: [], summary: [], total: 0 }, 'Alert feed retrieved (no devices)');
    }

    const response = await apiClient.makeRequest('/alarm/alarmPage', {
      pageSize: parseInt(pageSize),
      pageIndex: parseInt(pageIndex),
      deviceIds,
      alarmType: ALERT_TYPE_LIST.join(','),
      startTime: startTime || defaultStart,
      endTime: endTime || defaultEnd,
    });

    sendSuccess(res, response.data || response, 'Alert feed retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getAlarmFilesById = async (req, res) => {
  try {
    const { alarmId } = req.params;
    if (!alarmId) return sendError(res, 'Alarm ID required', 400);

    const response = await apiClient.makeRequest('/alarm/file/id', { alarmId });
    sendSuccess(res, response.data || response, 'Alarm files retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getAlarmFilesByPage = async (req, res) => {
  try {
    const now = new Date();
    const defaultEnd = now.toISOString().replace('T', ' ').slice(0, 19);
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const { pageSize = 50, pageIndex = 1, deviceIds, alarmType, startTime = defaultStart, endTime = defaultEnd } = req.body;
    const ids = deviceIds || (await getAllDeviceIds()).join(',');

    const response = await apiClient.makeRequest('/alarm/file/page', {
      pageSize: parseInt(pageSize),
      pageIndex: parseInt(pageIndex),
      deviceIds: ids,
      alarmType: alarmType || null,
      startTime,
      endTime,
    });

    sendSuccess(res, response.data || response, 'Alert files retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

const getDevices = async (req, res) => {
  try {
    const records = [];
    let pageIndex = 1;
    let hasMore = true;
    while (hasMore) {
      const response = await apiClient.makeRequest('/device/page', {
        pageIndex, pageSize: 100, subsumption: true,
      });
      if (response.code === 0 && response.data.records.length > 0) {
        records.push(...response.data.records);
        pageIndex++;
        hasMore = response.data.records.length === 100;
      } else {
        hasMore = false;
      }
    }
    sendSuccess(res, { records, total: records.length }, 'Devices retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
};

module.exports = {
  getAlertTypes,
  getAlarmPage,
  getAlertFeed,
  getAlarmFilesById,
  getAlarmFilesByPage,
  getDevices,
  ALERT_TYPE_LIST,
};
