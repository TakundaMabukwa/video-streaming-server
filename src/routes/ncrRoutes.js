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
/**
 * The creator of an NCR is the signed-in user. It must come from the verified
 * token — never from the request body and never a placeholder.
 */
function actorFromRequest(req) {
  const user = req.user || {};
  const email = String(user.email || user.user_metadata?.email || '').trim();
  if (!email) return null;
  return { id: user.id || user.sub || null, email };
}

router.post('/', async (req, res) => {
  try {
    const { groupId, alertGroupId, form, evidence, archive } = req.body || {};
    const gid = groupId ?? alertGroupId;
    const actor = actorFromRequest(req);
    if (!actor) {
      return res.status(422).json({
        success: false,
        message:
          'Your session has no email address, so the NCR cannot be attributed to you. Please sign in again with an account that has an email.',
      });
    }
    const result = await ncrService.createNcrFromAlert({
      groupId: gid,
      form: form || {},
      evidence: Array.isArray(evidence) ? evidence : [],
      actor,
      archive: archive === true,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }
    res.json({
      success: true,
      ncrFormId: result.ncrFormId,
      incidentId: result.incidentId,
      ncrNo: result.ncrNo,
      updated: result.updated === true,
      creatorEmail: result.creatorEmail,
      archiveRequested: archive === true,
    });
  } catch (error) {
    console.error('[NCR] create failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /ncr/standalone — a blank NCR created from the Drivers page.
// No alert group: the incident row is the register anchor.
router.post('/standalone', async (req, res) => {
  try {
    const { form, evidence } = req.body || {};
    const actor = actorFromRequest(req);
    if (!actor) {
      return res.status(422).json({
        success: false,
        message:
          'Your session has no email address, so the NCR cannot be attributed to you. Please sign in again with an account that has an email.',
      });
    }

    const result = await ncrService.createStandaloneNcr({
      form: form || {},
      evidence: Array.isArray(evidence) ? evidence : [],
      actor,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }
    res.json({
      success: true,
      ncrFormId: result.ncrFormId,
      incidentId: result.incidentId,
      ncrNo: result.ncrNo,
      creatorEmail: result.creatorEmail,
    });
  } catch (error) {
    console.error('[NCR] standalone create failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/register — NCR register list (ncr_forms JOIN incidents).
// Independent of alert_groups so the register survives an alert-history clear.
router.get('/register', async (req, res) => {
  try {
    const reportStats = require('../db/reportStats');
    const { status, from, to, costCenterIds, q, pageSize, pageIndex } = req.query;
    const data = await reportStats.getNcrRegister({
      status, from, to, costCenterIds, q,
      pageSize: parseInt(pageSize) || 50,
      pageIndex: parseInt(pageIndex) || 1,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[NCR] Register error:', err.message);
    res.status(500).json({ success: false, message: err.message });
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

// PATCH /ncr/:formId — edit form_data fields on an open NCR. Mirrors key
// fields back to the incident register so both views stay in sync.
router.patch('/:formId', async (req, res) => {
  try {
    const formId = String(req.params.formId || '').trim();
    if (!formId) return res.status(400).json({ success: false, message: 'formId is required' });
    const body = req.body || {};
    // Only block editing CLOSED NCRs (OPEN and REVIEW are editable).
    const check = await db.query(
      `SELECT nf.id, nf.incident_id, nf.status FROM ncr_forms nf
       JOIN incidents i ON i.id = nf.incident_id WHERE nf.id = $1`,
      [formId]
    );
    if (check.rows.length === 0) return res.status(404).json({ success: false, message: 'NCR not found' });
    const formStatus = String(check.rows[0].status || '').toUpperCase();
    if (formStatus === 'CLOSED') {
      return res.status(400).json({ success: false, message: 'Cannot edit a CLOSED NCR' });
    }

    // Build form_data patch from all incoming fields (excluding known non-form keys).
    const RESERVED = new Set(['id', 'incident_id', 'incidentId', 'formId', 'form_id', 'status', 'created_at', 'updated_at', 'closed_at']);
    const formPatch = {};
    for (const [key, value] of Object.entries(body)) {
      if (RESERVED.has(key)) continue;
      formPatch[key] = value;
    }

    // Mirror key fields to the incident register.
    const MIRROR = {
      driverName: 'driver_name',
      contactNumber: 'contact_number',
      idNumber: 'id_number',
      vehicleFleetNumber: 'fleet_number',
      description: 'infringement_detail',
      correctiveAction: 'action_taken',
      outcome: 'outcome',
      notes: 'notes',
    };
    const incPatch = {};
    for (const [formKey, incKey] of Object.entries(MIRROR)) {
      if (body[formKey] === undefined) continue;
      const v = body[formKey];
      incPatch[incKey] = typeof v === 'string' ? v.trim() || null : (v ?? null);
    }
    if (body.classifications !== undefined) {
      const raw = Array.isArray(body.classifications) ? body.classifications : [];
      incPatch.infringement = raw.filter(Boolean).join(', ') || null;
    }

    // Update form_data.
    if (Object.keys(formPatch).length > 0) {
      await db.query(
        `UPDATE ncr_forms SET form_data = form_data || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [formId, JSON.stringify(formPatch)]
      );
    }

    // Update workflow status (OPEN / REVIEW / CLOSED) on the NCR form.
    const VALID_STATUSES = new Set(['OPEN', 'REVIEW', 'CLOSED']);
    const newStatus = String(body.status || '').toUpperCase();
    if (VALID_STATUSES.has(newStatus) && newStatus !== formStatus) {
      await db.query(
        `UPDATE ncr_forms
            SET status = $2::text,
                closed_at = CASE
                  WHEN $2::text = 'CLOSED' THEN COALESCE(closed_at, NOW())
                  ELSE NULL
                END,
                updated_at = NOW()
          WHERE id = $1`,
        [formId, newStatus]
      );
    }

    // Update incident register.
    if (Object.keys(incPatch).length > 0) {
      const sets = [];
      const params = [];
      for (const [key, value] of Object.entries(incPatch)) {
        params.push(value);
        sets.push(`${key} = $${params.length}`);
      }
      params.push(check.rows[0].incident_id);
      sets.push('updated_at = NOW()');
      await db.query(
        `UPDATE incidents SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }

    const updated = await ncrService.getNcrForm(formId);
    res.json({ success: true, form: updated });
  } catch (error) {
    console.error('[NCR] PATCH error:', error.message);
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
    const { deviceId, fleetNumber, status, limit, days } = req.query;
    const rows = await alertFootage.listFootage({ deviceId, fleetNumber, status, limit, sinceDays: days });
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/footage/devices — vehicles that have footage in the last N days.
router.get('/footage/devices', async (req, res) => {
  try {
    const rows = await alertFootage.listFootageDevices({ sinceDays: req.query.days });
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /ncr/footage/refresh — ask for the footage again (the camera may have
// been off when the alert fired; this polls the upload and asks again).
router.post('/footage/refresh', async (req, res) => {
  try {
    const { alertId, alertGroupId, deviceId, fleetNumber, registration, alarmType, alertTime } = req.body || {};
    if (!alertId && !alertGroupId) {
      return res.status(400).json({ success: false, message: 'alertId or alertGroupId required' });
    }
    const result = await alertFootage.refreshIncidentFootage({
      alertId: alertId || null,
      alertGroupId: alertGroupId ? Number(alertGroupId) : null,
      deviceId: deviceId || null,
      fleetNumber: fleetNumber || null,
      registration: registration || null,
      alarmType: alarmType || null,
      alertTime: alertTime || null,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/alert-groups/:groupId/media — every member detection's media
// (the "apply all media to docs" source).
function archivePayload(row) {
  if (!row) return null;
  return {
    status: row.status || null,
    url: row.url || null,
    error: row.error || null,
    fileCount: row.file_count || 0,
    byteSize: Number(row.byte_size || 0),
    updatedAt: row.updated_at || null,
  };
}

// POST /ncr/alert-groups/:groupId/archive — build (or reuse) the evidence ZIP.
router.post('/alert-groups/:groupId/archive', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid alert group id' });
    }
    const actor = actorFromRequest(req);
    if (!actor) {
      return res.status(422).json({ success: false, message: 'Your session has no email address' });
    }
    const { requestGroupArchive } = require('../services/incidentArchiveService');
    const row = await requestGroupArchive(groupId, {
      requestedBy: actor.email,
      force: req.body?.force === true,
    });
    res.json({ success: true, archive: archivePayload(row) });
  } catch (error) {
    console.error('[NCR] archive request failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /ncr/alert-groups/:groupId/archive — poll the archive build.
router.get('/alert-groups/:groupId/archive', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid alert group id' });
    }
    const { getGroupArchive } = require('../services/incidentArchiveService');
    const row = await getGroupArchive(groupId);
    res.json({ success: true, archive: archivePayload(row) });
  } catch (error) {
    console.error('[NCR] archive lookup failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/alert-groups/:groupId/media', async (req, res) => {
  try {
    // Live camera lookups can exceed the server's default 30s socket timeout.
    req.setTimeout(120000);
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
