const { sendSuccess } = require('../helpers/response');

const getHealth = (req, res) => {
  const healthData = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };
  
  sendSuccess(res, healthData, 'Server is healthy');
};

module.exports = {
  getHealth
};