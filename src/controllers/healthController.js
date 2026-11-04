const { sendSuccess } = require('../helpers/response');

const getHealth = (req, res) => {
  let poller = null;
  try {
    poller = require('../services/deviceStatusPoller').getPollHealth();
  } catch (_) { /* poller not loaded */ }
  let workers = [];
  try { workers = require('../workers/registry').getHealth(); } catch (_) { /* optional */ }
  const healthData = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    poller,
    workers,
  };
  
  sendSuccess(res, healthData, 'Server is healthy');
};

module.exports = {
  getHealth
};