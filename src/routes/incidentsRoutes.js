const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/incidents - Incident register list (paginated)
router.get('/', async (req, res) => {
  try {
    const { cost_center_id, cost_center_ids, fleet_number, status, from, to, pageSize, pageIndex } = req.query;
    const data = await db.getIncidents({
      cost_center_id,
      cost_center_ids,
      fleet_number,
      status,
      from,
      to,
      pageSize: parseInt(pageSize) || 50,
      pageIndex: parseInt(pageIndex) || 1,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Incidents] List error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/incidents/:id - Single incident
router.get('/:id', async (req, res) => {
  try {
    const incident = await db.getIncident(req.params.id);
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found' });
    res.json({ success: true, incident });
  } catch (err) {
    console.error('[Incidents] Get error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/incidents/:id - Update register fields (action_taken / outcome / form data)
router.patch('/:id', async (req, res) => {
  try {
    const incident = await db.updateIncidentFields(req.params.id, req.body || {});
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found or no editable fields' });
    res.json({ success: true, incident });
  } catch (err) {
    console.error('[Incidents] Update error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;