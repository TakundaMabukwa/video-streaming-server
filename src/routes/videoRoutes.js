const express = require('express');
const { getVideos, getVideoById } = require('../controllers/videoController');

const router = express.Router();

router.get('/', getVideos);
router.get('/:id', getVideoById);

module.exports = router;