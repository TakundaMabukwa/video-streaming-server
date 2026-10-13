const { sendSuccess } = require('../helpers/response');

const getHealth = (req, res) => {
  let poller = null;
  try {
    poller = require('../services/deviceStatusPoller').getPollHealth();
  } catch (_) { /* poller not loaded */ }
  const healthData = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    poller,
  };
  
  sendSuccess(res, healthData, 'Server is healthy');
};

module.exports = {
  getHealth
};