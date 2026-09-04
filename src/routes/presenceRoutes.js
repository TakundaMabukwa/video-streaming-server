const express = require('express');
const { getViewers, getViewersExcept } = require('../services/presence');

const router = express.Router();

// GET /api/presence/alerts/:alertId
// Returns list of users currently viewing the given alert.
// Excludes the requesting user via ?exclude=userEmail when provided.
router.get('/alerts/:alertId', (req, res) => {
  const alertId = String(req.params.alertId || '').trim();
  if (!alertId) {
    return res.json({ ok: false, error: 'missing alert id', viewers: [] });
  }
  const exclude = String(req.query.exclude || '').trim();
  const viewers = exclude ? getViewersExcept(alertId, exclude) : getViewers(alertId);
  return res.json({ ok: true, alertId, viewers });
});

module.exports = router;
