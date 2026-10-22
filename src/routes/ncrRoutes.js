const express = require('express');
const db = require('../db');
const ncrService = require('../services/ncrService');
const alertFootage = require('../services/alertFootageService');
const vehicleGroupMedia = require('../services/vehicleGroupMedia');

const router = express.Router();

// POST /ncr/outbox — enqueue finished escalation emails; returns in ms.
// Delivery + retry happens in the ncrEmailSweeper, never in the request.
router.post('/outbox', async (req, res) => {
  try {
    const { to, subject, html, ncr_no, group_name } = req.body || {};
    const addrs = Array.isArray(to) ? to.map((a) => String(a || '').trim()).filter(Boolean) : [];
    if (addrs.length === 0 || !subject || !html) {
      return res.status(400).json({ success: false, message: 'to[], subject and html are required' });
    }
    const r = await db.query(
      `INSERT INTO ncr_email_outbox (to_addrs, subject, html, ncr_no, group_name)
       VALUES ($1::text[], $2, $3, $4, $5) RETURNING id`,
      [addrs, String(subject), String(html), ncr_no ? String(ncr_no) : null, group_name ? String(group_name) : null]
    );
    res.json({ success: true, queued: true, id: r.rows[0].id, recipients: addrs.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/outbox-status — recent delivery state for ops visibility.
router.get('/outbox-status', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM ncr_email_outbox
       WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status`
    );
    res.json({ success: true, states: r.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /ncr — store the signed NCR document. FAST: the register row, the
// document and the evidence go in one transaction, and the follow-up work
// (resolve + email) is queued. The user never waits for a PDF or an email.
router.post('/', async (req, res) => {
  try {
    const { groupId, alertGroupId, form, evidence, userId } = req.body || {};
    const gid = groupId ?? alertGroupId;
    const result = await ncrService.createNcrFromAlert({
      groupId: gid,
      form: form || {},
      evidence: Array.isArray(evidence) ? evidence : [],
      userId: userId || null,
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.error });
    }
    res.json({
      success: true,
      ncrFormId: result.ncrFormId,
      incidentId: result.incidentId,
      ncrNo: result.ncrNo,
    });
  } catch (error) {
    console.error('[NCR] create failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/:formId — the stored document (read-only register view).
router.get('/:formId', async (req, res) => {
  try {
    const form = await ncrService.getNcrForm(req.params.formId);
    if (!form) return res.status(404).json({ success: false, message: 'NCR not found' });
    res.json({ success: true, form });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/incident/:incidentId — the stored document for a register row.
router.get('/incident/:incidentId', async (req, res) => {
  try {
    const form = await ncrService.getNcrFormByIncident(req.params.incidentId);
    if (!form) return res.status(404).json({ success: false, message: 'No NCR form for this incident' });
    res.json({ success: true, form });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /ncr/:formId/document — the client reports the PDF it rendered in the
// background (the PDF stays pixel-perfect; only the upload is fire-and-forget).
router.post('/:formId/document', async (req, res) => {
  try {
    const { documentPath, documentUrl } = req.body || {};
    const path = String(documentPath || documentUrl || '').trim();
    if (!path) return res.status(400).json({ success: false, message: 'documentPath is required' });
    const updated = await ncrService.attachDocument(req.params.formId, path);
    if (!updated) return res.status(404).json({ success: false, message: 'NCR not found' });
    res.json({ success: true, document_path: updated.document_path, document_status: updated.document_status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/footage — stored incident footage (Alert Footage tab).
router.get('/footage/list', async (req, res) => {
  try {
    const { deviceId, fleetNumber, status, limit } = req.query;
    const rows = await alertFootage.listFootage({ deviceId, fleetNumber, status, limit });
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/footage/devices — vehicles that have footage.
router.get('/footage/devices', async (req, res) => {
  try {
    const rows = await alertFootage.listFootageDevices();
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/alert-groups/:groupId/media — every member detection's media
// (the "apply all media to docs" source).
router.get('/alert-groups/:groupId/media', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid group id' });
    }
    const result = await vehicleGroupMedia.mediaForGroup(groupId, {
      limit: Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
