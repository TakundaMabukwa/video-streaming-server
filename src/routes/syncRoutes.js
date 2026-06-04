const express = require('express');
const syncService = require('../services/syncService');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ success: true, state: syncService.getStatus() });
});

router.post('/refetch-media', async (req, res) => {
  const result = await syncService.refetchMissingMedia();
  res.json({ success: true, ...result });
});

module.exports = router;
