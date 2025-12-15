require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  videoApiKey: process.env.VIDEO_API_KEY,
  videoApiSecret: process.env.VIDEO_API_SECRET
};