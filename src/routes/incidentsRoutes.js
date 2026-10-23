const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/incidents - Incident register list (paginated)
router.get('/', async (req, res) => {
  try {
    const { cost_center_id, cost_center_ids, fleet_number, status, from, to, has_ncr, pageSize, pageIndex } = req.query;
    const data = await db.getIncidents({
      cost_center_id,
      cost_center_ids,
      fleet_number,
      status,
      from,
      to,
      // Only incidents that actually have an NCR document attached.
      hasNcr: has_ncr,
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

// POST /api/incidents/:id/close — close an NCR from the register.
// Works for OPEN and RESOLVED records (a resolved NCR can still be signed
// off). Sets the canonical CLOSED status and resolves the linked alert
// group (if still open) so the register and the board never disagree.
router.post('/:id/close', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ success: false, message: 'Invalid incident id' });
    }
    const existing = await db.getIncident(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Incident not found' });
    const status = String(req.body?.status || 'CLOSED').toUpperCase();
    const closedBy = String(req.body?.resolved_by || '').trim() || null;
    const notes = String(req.body?.notes || '').trim() || null;

    const incident = await db.updateIncidentFields(id, {
      status,
      resolved_by: closedBy,
      resolved_at: new Date().toISOString(),
      closure_type: existing.closure_type || 'ncr',
      ...(notes ? { notes } : {}),
    });
    if (!incident) return res.status(400).json({ success: false, message: 'Could not close incident' });

    // Resolve the linked alert group so the board matches the register.
    let alertGroupResolved = false;
    const groupKey = String(existing.alert_group_key || '').trim();
    if (groupKey) {
      try {
        const res = await db.query(
          `UPDATE alert_groups
           SET resolved = TRUE, resolved_by = $2, resolved_at = NOW(), updated_at = NOW()
           WHERE group_key = $1 AND resolved = FALSE AND false_alert = FALSE`,
          [groupKey, closedBy]
        );
        alertGroupResolved = res.rowCount > 0;
      } catch (err) {
        console.error('[Incidents] linked alert resolve failed:', err.message);
      }
    }

    console.log(
      `[Incidents] closed #${id} (${existing.incident_no || ''}) by ${closedBy || 'unknown'}` +
      `${alertGroupResolved ? ' + linked alert group resolved' : ''}`
    );
    res.json({ success: true, incident, alert_group_resolved: alertGroupResolved });
  } catch (err) {
    console.error('[Incidents] Close error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;