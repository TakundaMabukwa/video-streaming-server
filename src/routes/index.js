const express = require('express');
const healthRoutes = require('./healthRoutes');
const videoRoutes = require('./videoRoutes');
const streamRoutes = require('./streamRoutes');
const galleryRoutes = require('./galleryRoutes');
const playbackRoutes = require('./playbackRoutes');
const alertRoutes = require('./alertRoutes');
const alertConfigRoutes = require('./alertConfigRoutes');
const driverConfigRoutes = require('./driverConfigRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/videos', videoRoutes);
router.use('/stream', streamRoutes);
router.use('/gallery', galleryRoutes);
router.use('/playback', playbackRoutes);
router.use('/alerts', alertRoutes);
router.use('/alert-config', alertConfigRoutes);
router.use('/driver-config', driverConfigRoutes);

module.exports = router;