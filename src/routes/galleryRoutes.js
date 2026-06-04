const express = require('express');
const { getGalleryFiles, triggerCapture, getCapturePage } = require('../controllers/galleryController');

const router = express.Router();

router.post('/files/page', getGalleryFiles);
router.post('/capture', triggerCapture);
router.post('/capture/page', getCapturePage);

module.exports = router;
