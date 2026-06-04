const express = require('express');
const healthRoutes = require('./healthRoutes');
const videoRoutes = require('./videoRoutes');
const streamRoutes = require('./streamRoutes');
const alertRoutes = require('./alertRoutes');
const dbAlertRoutes = require('./dbAlertRoutes');
const syncRoutes = require('./syncRoutes');
const galleryRoutes = require('./galleryRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/videos', videoRoutes);
router.use('/stream', streamRoutes);
router.use('/alerts', alertRoutes);
router.use('/db/alerts', dbAlertRoutes);
router.use('/sync', syncRoutes);
router.use('/gallery', galleryRoutes);

module.exports = router;