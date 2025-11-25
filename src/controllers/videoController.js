const { sendSuccess, sendError } = require('../helpers/response');

const getVideos = (req, res) => {
  const videos = [
    { id: 1, title: 'Sample Video 1', duration: '10:30' },
    { id: 2, title: 'Sample Video 2', duration: '15:45' }
  ];
  
  sendSuccess(res, videos, 'Videos retrieved successfully');
};

const getVideoById = (req, res) => {
  const { id } = req.params;
  
  if (!id || isNaN(id)) {
    return sendError(res, 'Invalid video ID', 400);
  }
  
  const video = { id: parseInt(id), title: `Video ${id}`, duration: '12:00' };
  sendSuccess(res, video, 'Video retrieved successfully');
};

module.exports = {
  getVideos,
  getVideoById
};