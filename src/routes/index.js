const express = require('express');
const healthRoutes = require('./healthRoutes');
const videoRoutes = require('./videoRoutes');
const streamRoutes = require('./streamRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/videos', videoRoutes);
router.use('/stream', streamRoutes);

module.exports = router;