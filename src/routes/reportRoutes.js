// Reports API — a NEW read/write surface for the incident register, the
// cost-centre statistics, the driver statistics and NCR documents.
//
// Design rules (the whole point of this namespace):
//   * NO server-side filtering by cost centre, date, status or "has NCR".
//     Every endpoint returns the complete set; the frontend filters and
//     counts. A row can never disappear because of a WHERE clause.
//   * Every number the UI shows comes from the same complete set, so the
//     cards, the tab labels and the table can never disagree.
//   * Documents live in a PRIVATE bucket; downloads are short-lived signed
//     URLs issued only to signed-in users.
const express = require('express');
const db = require('../db');
const reportStats = require('../db/reportStats');
const linkage = require('../services/reportLinkage');
const storage = require('../helpers/storage');

const router = express.Router();

// ── helpers ────────────────────────────────────────────────────────────────
function monthBuckets() {
  const now = new Date();
  // SAST month boundaries (the register dates are SAST dates).
  const sastNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const thisMonthStart = new Date(Date.UTC(sastNow.getUTCFullYear(), sastNow.getUTCMonth(), 1) - 2 * 60 * 60 * 1000);
  const lastMonthStart = new Date(Date.UTC(sastNow.getUTCFullYear(), sastNow.getUTCMonth() - 1, 1) - 2 * 60 * 60 * 1000);
  const nextMonthStart = new Date(Date.UTC(sastNow.getUTCFullYear(), sastNow.getUTCMonth() + 1, 1) - 2 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    thisMonth: iso(thisMonthStart),
    lastMonth: iso(lastMonthStart),
    nextMonth: iso(nextMonthStart),
    thisMonthLabel: `${sastNow.getUTCFullYear()}-${String(sastNow.getUTCMonth() + 1).padStart(2, '0')}`,
    lastMonthLabel: (() => {
      const d = new Date(Date.UTC(sastNow.getUTCFullYear(), sastNow.getUTCMonth() - 1, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })(),
  };
}

function monthOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 7);
  }
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 7);
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── GET /eps/reports/incidents ───────────────────────────────────────────
// EVERY incident, resolved for vehicle + driver cost centre. The frontend
// does all filtering from this one payload.
router.get('/incidents', async (req, res) => {
  try {
    const [incidents, closedGroups, ncrForms] = await Promise.all([
      reportStats.getAllIncidents(),
      reportStats.getAllClosedGroups(),
      reportStats.getAllNcrForms(),
    ]);

    const ctx = await linkage.createContext();

    // NCR + document info per incident (already counted in the SQL).
    const formsByIncident = new Map();
    for (const form of ncrForms) {
      if (!form.incident_id) continue;
      const list = formsByIncident.get(form.incident_id) || [];
      list.push(form);
      formsByIncident.set(form.incident_id, list);
    }

    // Closed groups carry the alert-level view (counts per vehicle/type).
    const closedByGroupKey = new Map();
    for (const group of closedGroups) closedByGroupKey.set(group.group_key, group);

    const rows = [];
    for (const inc of incidents) {
      const resolved = await linkage.resolveRow(
        {
          cost_center_id: inc.cost_center_id,
          device_id: inc.device_id,
          device_name: inc.device_name,
          fleet_number: inc.fleet_number || inc.group_fleet,
          driver_name: inc.driver_name,
          id_number: inc.id_number,
        },
        ctx
      );

      const forms = formsByIncident.get(inc.id) || [];
      const closed = inc.alert_group_key ? closedByGroupKey.get(inc.alert_group_key) : null;

      rows.push({
        id: inc.id,
        incident_no: inc.incident_no,
        status: inc.status,
        incident_date: inc.incident_date,
        incident_time: inc.incident_time,
        created_at: inc.created_sast,
        alert_id: inc.alert_id,
        alert_group_key: inc.alert_group_key,
        alarm_type: inc.alarm_type,
        source_type: inc.source_type,
        device_id: inc.device_id,
        device_name: inc.device_name,
        fleet_number: inc.fleet_number,
        driver_name: inc.driver_name,
        driver_display: resolved.driver_name,
        id_number: inc.id_number,
        contact_number: inc.contact_number,
        division: inc.division,
        infringement: inc.infringement,
        infringement_detail: inc.infringement_detail,
        action_taken: inc.action_taken,
        outcome: inc.outcome,
        notes: inc.notes,
        controller: inc.controller,
        resolved_by: inc.resolved_by,
        resolved_at: inc.resolved_at,
        closure_type: inc.closure_type,
        has_alert_group: inc.has_alert_group,
        alert_count: Number(inc.alert_count || 0),
        has_ncr: Number(inc.ncr_count || 0) > 0,
        ncr_count: Number(inc.ncr_count || 0),
        ncr_nos: inc.ncr_nos || null,
        ncr_form_ids: inc.ncr_form_ids || null,
        ncr_statuses: forms.map((f) => f.status).filter(Boolean),
        doc_count: Number(inc.doc_count || 0),
        closed_alert_count: closed ? Number(closed.count || 0) : null,
        closed_at: closed ? closed.closed_sast : null,
        ...resolved,
      });
    }

    const closedRows = [];
    for (const group of closedGroups) {
      const resolved = await linkage.resolveRow(
        {
          device_id: group.device_id,
          device_name: group.device_name,
          fleet_number: group.fleet_number,
        },
        ctx
      );
      closedRows.push({
        group_id: group.id,
        group_key: group.group_key,
        device_id: group.device_id,
        device_name: group.device_name,
        alarm_type: group.alarm_type,
        severity: group.severity,
        alert_count: Number(group.count || 0),
        source_type: group.source_type,
        last_alert_ts: group.last_alert_ts,
        closed_at: group.closed_sast,
        closed_date: group.closed_date,
        ...resolved,
      });
    }

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      months: monthBuckets(),
      cost_centers: await reportStats.getCostCenters(),
      incidents: rows,
      closed_alerts: closedRows,
    });
  } catch (err) {
    console.error('[Reports] incidents error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /eps/reports/cost-centre-stats ───────────────────────────────────
// Counts per cost centre: closed alerts + NCRs, this month vs last month.
// Unattributed rows are reported as an explicit "Unassigned" bucket — they
// are never dropped.
router.get('/cost-centre-stats', async (req, res) => {
  try {
    const [incidents, closedGroups, ncrForms, costCenters] = await Promise.all([
      reportStats.getAllIncidents(),
      reportStats.getAllClosedGroups(),
      reportStats.getAllNcrForms(),
      reportStats.getCostCenters(),
    ]);

    const ctx = await linkage.createContext();
    const months = monthBuckets();

    const ncrByIncident = new Map();
    for (const form of ncrForms) {
      if (!form.incident_id) continue;
      ncrByIncident.set(form.incident_id, (ncrByIncident.get(form.incident_id) || 0) + 1);
    }

    const stats = new Map();
    const ensure = (ccId) => {
      const key = ccId == null ? 'unassigned' : String(ccId);
      if (!stats.has(key)) {
        stats.set(key, {
          cc_id: ccId == null ? null : Number(ccId),
          cc_name: ccId == null ? 'Unassigned' : null,
          alerts_this_month: 0,
          alerts_last_month: 0,
          alerts_total: 0,
          alert_events_this_month: 0,
          alert_events_last_month: 0,
          alert_events_total: 0,
          ncrs_this_month: 0,
          ncrs_last_month: 0,
          ncrs_total: 0,
          vehicles: new Set(),
          drivers: new Set(),
        });
      }
      return stats.get(key);
    };

    // Closed alerts per cost centre (alert-level truth). alerts_* counts the
    // closed alert GROUPS (what the "Closed Alerts" card has always counted);
    // alert_events_* counts the individual detections inside them.
    for (const group of closedGroups) {
      const resolved = await linkage.resolveRow(
        { device_id: group.device_id, device_name: group.device_name, fleet_number: group.fleet_number },
        ctx
      );
      const bucket = ensure(resolved.cc_id);
      const ym = monthOf(group.closed_date);
      const events = Number(group.count || 0);
      bucket.alerts_total += 1;
      bucket.alert_events_total += events;
      if (ym === months.thisMonthLabel) { bucket.alerts_this_month += 1; bucket.alert_events_this_month += events; }
      else if (ym === months.lastMonthLabel) { bucket.alerts_last_month += 1; bucket.alert_events_last_month += events; }
      if (resolved.vehicle_fleet) bucket.vehicles.add(resolved.vehicle_fleet);
      if (resolved.driver_name) bucket.drivers.add(resolved.driver_name);
    }

    // NCRs per cost centre (document truth).
    for (const inc of incidents) {
      const ncrCount = Number(ncrByIncident.get(inc.id) || 0);
      if (!ncrCount) continue;
      const resolved = await linkage.resolveRow(
        {
          cost_center_id: inc.cost_center_id,
          device_id: inc.device_id,
          device_name: inc.device_name,
          fleet_number: inc.fleet_number || inc.group_fleet,
          driver_name: inc.driver_name,
          id_number: inc.id_number,
        },
        ctx
      );
      const bucket = ensure(resolved.cc_id);
      const ym = monthOf(inc.incident_date || inc.created_sast);
      bucket.ncrs_total += ncrCount;
      if (ym === months.thisMonthLabel) bucket.ncrs_this_month += ncrCount;
      else if (ym === months.lastMonthLabel) bucket.ncrs_last_month += ncrCount;
    }

    const ccNameById = new Map(costCenters.map((cc) => [Number(cc.id), cc.name]));
    const rows = [...stats.values()].map((bucket) => ({
      cc_id: bucket.cc_id,
      cc_name: bucket.cc_id == null ? 'Unassigned' : (ccNameById.get(bucket.cc_id) || `CC ${bucket.cc_id}`),
      alerts_this_month: bucket.alerts_this_month,
      alerts_last_month: bucket.alerts_last_month,
      alerts_total: bucket.alerts_total,
      alert_events_this_month: bucket.alert_events_this_month,
      alert_events_last_month: bucket.alert_events_last_month,
      alert_events_total: bucket.alert_events_total,
      ncrs_this_month: bucket.ncrs_this_month,
      ncrs_last_month: bucket.ncrs_last_month,
      ncrs_total: bucket.ncrs_total,
      vehicles: bucket.vehicles.size,
      drivers: bucket.drivers.size,
    })).sort((a, b) => (b.alerts_this_month + b.ncrs_this_month) - (a.alerts_this_month + a.ncrs_this_month));

    res.json({ success: true, generated_at: new Date().toISOString(), months, cost_centers: costCenters, stats: rows });
  } catch (err) {
    console.error('[Reports] cost-centre-stats error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /eps/reports/cost-centre/:ccId/rows ──────────────────────────────
// The drill-down behind a cost-centre card: that cost centre's closed
// alerts and its NCR incidents.
router.get('/cost-centre/:ccId/rows', async (req, res) => {
  try {
    const ccId = asInt(req.params.ccId);
    if (ccId == null && String(req.params.ccId).toLowerCase() !== 'unassigned') {
      return res.status(400).json({ success: false, message: 'Invalid cost centre id' });
    }
    const [incidents, closedGroups] = await Promise.all([
      reportStats.getAllIncidents(),
      reportStats.getAllClosedGroups(),
    ]);
    const ctx = await linkage.createContext();

    const alertRows = [];
    for (const group of closedGroups) {
      const resolved = await linkage.resolveRow(
        { device_id: group.device_id, device_name: group.device_name, fleet_number: group.fleet_number },
        ctx
      );
      const bucket = resolved.cc_id;
      if (ccId === null ? bucket !== null : bucket !== ccId) continue;
      alertRows.push({
        group_id: group.id,
        group_key: group.group_key,
        device_name: group.device_name,
        alarm_type: group.alarm_type,
        severity: group.severity,
        alert_count: Number(group.count || 0),
        source_type: group.source_type,
        last_alert_ts: group.last_alert_ts,
        closed_at: group.closed_sast,
        fleet_number: resolved.vehicle_fleet,
        driver_name: resolved.driver_name,
      });
    }

    const incidentRows = [];
    for (const inc of incidents) {
      const resolved = await linkage.resolveRow(
        {
          cost_center_id: inc.cost_center_id,
          device_id: inc.device_id,
          device_name: inc.device_name,
          fleet_number: inc.fleet_number || inc.group_fleet,
          driver_name: inc.driver_name,
          id_number: inc.id_number,
        },
        ctx
      );
      const bucket = resolved.cc_id;
      if (ccId === null ? bucket !== null : bucket !== ccId) continue;
      incidentRows.push({
        id: inc.id,
        incident_no: inc.incident_no,
        status: inc.status,
        incident_date: inc.incident_date,
        fleet_number: resolved.vehicle_fleet,
        driver_name: resolved.driver_name,
        infringement: inc.infringement,
        has_ncr: Number(inc.ncr_count || 0) > 0,
        ncr_nos: inc.ncr_nos || null,
      });
    }

    res.json({
      success: true,
      cost_centre_id: ccId,
      closed_alerts: alertRows,
      incidents: incidentRows,
    });
  } catch (err) {
    console.error('[Reports] cost-centre rows error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /eps/reports/driver-stats ────────────────────────────────────────
// Drivers that have NCRs: NCR count for the month, alert count (offences)
// for the same month, and the NCR ids so the UI can open each document.
router.get('/driver-stats', async (req, res) => {
  try {
    const [incidents, closedGroups, ncrForms] = await Promise.all([
      reportStats.getAllIncidents(),
      reportStats.getAllClosedGroups(),
      reportStats.getAllNcrForms(),
    ]);
    const ctx = await linkage.createContext();
    const months = monthBuckets();

    const ncrByIncident = new Map();
    for (const form of ncrForms) {
      if (!form.incident_id) continue;
      const list = ncrByIncident.get(form.incident_id) || [];
      list.push({ id: form.id, ncr_no: form.ncr_no, status: form.status, created_at: form.created_at });
      ncrByIncident.set(form.incident_id, list);
    }

    // Closed alerts per vehicle (offences) — keyed by the resolved vehicle.
    const alertsByVehicle = new Map();
    for (const group of closedGroups) {
      const resolved = await linkage.resolveRow(
        { device_id: group.device_id, device_name: group.device_name, fleet_number: group.fleet_number },
        ctx
      );
      const key = resolved.vehicle_fleet || resolved.driver_key || group.group_key;
      const ym = monthOf(group.closed_date);
      const entry = alertsByVehicle.get(key) || { total: 0, this_month: 0, last_month: 0 };
      entry.total += Number(group.count || 0);
      if (ym === months.thisMonthLabel) entry.this_month += Number(group.count || 0);
      else if (ym === months.lastMonthLabel) entry.last_month += Number(group.count || 0);
      alertsByVehicle.set(key, entry);
    }

    const drivers = new Map();
    for (const inc of incidents) {
      const forms = ncrByIncident.get(inc.id) || [];
      if (!forms.length) continue; // only drivers with NCRs
      const resolved = await linkage.resolveRow(
        {
          cost_center_id: inc.cost_center_id,
          device_id: inc.device_id,
          device_name: inc.device_name,
          fleet_number: inc.fleet_number || inc.group_fleet,
          driver_name: inc.driver_name,
          id_number: inc.id_number,
        },
        ctx
      );
      const key = resolved.driver_key || resolved.driver_name || 'unknown';
      const entry = drivers.get(key) || {
        driver_key: key,
        driver_name: resolved.driver_name,
        driver_source: resolved.driver_source,
        driver_fleet: resolved.driver_fleet,
        vehicle_fleet: resolved.vehicle_fleet,
        vehicle_registration: resolved.vehicle_registration,
        vehicle_cc_id: resolved.vehicle_cc_id,
        driver_cc_id: resolved.driver_cc_id,
        cc_id: resolved.cc_id,
        ncrs_this_month: 0,
        ncrs_last_month: 0,
        ncrs_total: 0,
        offences_this_month: 0,
        offences_total: 0,
        ncrs: [],
      };
      const ym = monthOf(inc.incident_date || inc.created_sast);
      const count = forms.length;
      entry.ncrs_total += count;
      if (ym === months.thisMonthLabel) entry.ncrs_this_month += count;
      else if (ym === months.lastMonthLabel) entry.ncrs_last_month += count;
      for (const form of forms) {
        entry.ncrs.push({
          ncr_form_id: form.id,
          ncr_no: form.ncr_no,
          status: form.status,
          incident_id: inc.id,
          incident_no: inc.incident_no,
          incident_date: inc.incident_date,
          infringement: inc.infringement,
          fleet_number: resolved.vehicle_fleet,
          created_at: form.created_at,
        });
      }
      const vehicleKey = resolved.vehicle_fleet || key;
      const alertCounts = alertsByVehicle.get(vehicleKey) || alertsByVehicle.get(key);
      if (alertCounts) {
        entry.offences_total += alertCounts.total;
        entry.offences_this_month += alertCounts.this_month;
      }
      drivers.set(key, entry);
    }

    const rows = [...drivers.values()]
      .map((d) => ({
        ...d,
        ncrs: d.ncrs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
      }))
      .sort((a, b) => (b.ncrs_this_month - a.ncrs_this_month) || (b.offences_this_month - a.offences_this_month));

    res.json({ success: true, generated_at: new Date().toISOString(), months, drivers: rows });
  } catch (err) {
    console.error('[Reports] driver-stats error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /eps/reports/incidents/:id/documents ────────────────────────────
// Upload a document and link it to the NCR. The file goes to a PRIVATE
// bucket; only a signed-in user can later download it.
router.post('/incidents/:id/documents', async (req, res) => {
  try {
    const incidentId = String(req.params.id || '').trim();
    if (!incidentId) return res.status(400).json({ success: false, message: 'Incident id required' });
    // incidents.id is a UUID — a malformed id is a client error, not a crash.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incidentId)) {
      return res.status(400).json({ success: false, message: 'Invalid incident id' });
    }

    const incident = await db.getIncident(incidentId);
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found' });

    let fileName = null;
    let fileBuffer = null;
    let contentType = null;
    if (req.files && req.files.file) {
      fileBuffer = req.files.file.data;
      fileName = req.files.file.name;
      contentType = req.files.file.mimetype;
    } else if (req.body && req.body.file && req.body.file.data) {
      // JSON base64 upload (used when the browser sends the file as base64).
      fileBuffer = Buffer.from(req.body.file.data, 'base64');
      fileName = req.body.file.name || 'document';
      contentType = req.body.file.contentType || req.body.file.type || null;
    }
    if (!fileBuffer || !fileBuffer.length) {
      return res.status(400).json({ success: false, message: 'A file is required' });
    }

    const safeBase = String(fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const storagePath = `ncr/${incidentId}/${Date.now()}_${safeBase}`;
    await storage.uploadPrivateDocument(fileBuffer, storagePath, contentType);

    const forms = await db.query(
      `SELECT id FROM ncr_forms WHERE incident_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [incidentId]
    );
    const ncrFormId = forms.rows[0]?.id || null;

    const row = await reportStats.insertIncidentDocument({
      incident_id: incidentId,
      ncr_form_id: ncrFormId,
      name: String(fileName || 'document'),
      storage_path: storagePath,
      content_type: contentType,
      byte_size: fileBuffer.length,
      doc_type: String(req.body?.doc_type || req.body?.type || '').trim() || null,
      uploaded_by: String(req.user?.email || '').trim() || null,
    });

    const url = await storage.createPrivateDocumentUrl(storagePath);
    res.json({ success: true, document: row, url, expires_in: storage.SIGNED_URL_TTL_SECONDS });
  } catch (err) {
    console.error('[Reports] document upload error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /eps/reports/incidents/:id/documents ─────────────────────────────
// The document list with short-lived signed URLs (signed-in users only).
router.get('/incidents/:id/documents', async (req, res) => {
  try {
    const incidentId = String(req.params.id || '').trim();
    if (!incidentId) return res.status(400).json({ success: false, message: 'Incident id required' });
    const rows = await reportStats.getIncidentDocuments(incidentId);
    const documents = [];
    for (const row of rows) {
      const url = await storage.createPrivateDocumentUrl(row.storage_path);
      documents.push({ ...row, url });
    }
    res.json({ success: true, documents, expires_in: storage.SIGNED_URL_TTL_SECONDS });
  } catch (err) {
    console.error('[Reports] document list error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /eps/reports/incidents/:id/documents/:docId ───────────────────
router.delete('/incidents/:id/documents/:docId', async (req, res) => {
  try {
    const removed = await reportStats.deleteIncidentDocument(String(req.params.docId || '').trim());
    if (!removed) return res.status(404).json({ success: false, message: 'Document not found' });
    res.json({ success: true, removed: true });
  } catch (err) {
    console.error('[Reports] document delete error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /eps/reports/incidents/:id ───────────────────────────────────────
// One incident with its NCR documents and linked documents.
router.get('/incidents/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Incident id required' });
    const incident = await db.getIncident(id);
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found' });
    const forms = (await db.query(
      `SELECT id, ncr_no, status, document_path, document_status, archive_url, archive_status,
              created_by_email, created_at, updated_at, form_data
         FROM ncr_forms WHERE incident_id = $1 ORDER BY created_at DESC`,
      [id]
    )).rows;
    const documents = await reportStats.getIncidentDocuments(id);
    res.json({ success: true, incident, ncr_forms: forms, documents });
  } catch (err) {
    console.error('[Reports] incident detail error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /eps/reports/incidents/:id/ncr ───────────────────────────────────
// The stored NCR document for an incident (the register renders from it).
router.get('/incidents/:id/ncr', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Incident id required' });
    const row = (await db.query(
      `SELECT n.*, i.incident_no, i.fleet_number AS incident_fleet, i.driver_name AS incident_driver,
              i.infringement, i.incident_date
         FROM ncr_forms n
         LEFT JOIN incidents i ON i.id = n.incident_id
        WHERE n.incident_id = $1
        ORDER BY n.created_at DESC LIMIT 1`,
      [id]
    )).rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'No NCR document stored for this incident' });
    res.json({ success: true, form: row });
  } catch (err) {
    console.error('[Reports] NCR form error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /eps/reports/incidents/:id/close ────────────────────────────────
// Close an NCR from the register (OPEN or RESOLVED) and resolve the linked
// alert group so the board and the register never disagree.
router.post('/incidents/:id/close', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Incident id required' });
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

    let alertGroupResolved = false;
    const groupKey = String(existing.alert_group_key || '').trim();
    if (groupKey) {
      try {
        const result = await db.query(
          `UPDATE alert_groups
              SET resolved = TRUE, resolved_by = $2, resolved_at = NOW(), updated_at = NOW()
            WHERE group_key = $1 AND resolved = FALSE AND false_alert = FALSE`,
          [groupKey, closedBy]
        );
        alertGroupResolved = result.rowCount > 0;
      } catch (err) {
        console.error('[Reports] linked alert resolve failed:', err.message);
      }
    }

    res.json({ success: true, incident, alert_group_resolved: alertGroupResolved });
  } catch (err) {
    console.error('[Reports] incident close error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /eps/reports/incidents/:id ─────────────────────────────────────
// Edit the NCR itself. The incident row is updated AND the stored NCR
// document mirrors the change, so the register and the document can never
// disagree.
const NCR_FORM_MIRROR = {
  driver_name: 'driverName',
  contact_number: 'contactNumber',
  id_number: 'idNumber',
  fleet_number: 'vehicleFleetNumber',
  infringement_detail: 'description',
  action_taken: 'correctiveAction',
  outcome: 'outcome',
  notes: 'notes',
  division: 'department',
};
router.patch('/incidents/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const body = req.body || {};
    const incident = await db.updateIncidentFields(id, body);
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found or no editable fields' });

    const mirrorPatch = {};
    for (const [incKey, formKey] of Object.entries(NCR_FORM_MIRROR)) {
      if (body[incKey] === undefined) continue;
      const value = body[incKey];
      mirrorPatch[formKey] = typeof value === 'string' ? value.trim() || null : (value ?? null);
    }
    if (body.infringement !== undefined) {
      const raw = String(body.infringement ?? '').trim();
      mirrorPatch.classifications = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    }
    if (Object.keys(mirrorPatch).length > 0) {
      await db.query(
        `UPDATE ncr_forms SET form_data = form_data || $2::jsonb, updated_at = NOW()
          WHERE incident_id = $1`,
        [id, JSON.stringify(mirrorPatch)]
      ).catch((err) => console.error('[Reports] NCR form mirror failed:', err.message));
    }

    res.json({ success: true, incident });
  } catch (err) {
    console.error('[Reports] incident update error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
