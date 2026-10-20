const express = require('express');
const db = require('../db');
const overrides = require('../services/vehicleAlertOverrides');

const router = express.Router();

const norm = (v) => String(v || '').trim();
const toArray = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map((x) => norm(x))
    .filter(Boolean);

// GET /vehicle-overrides — list (optionally ?fleet= / ?registration=)
router.get('/', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.fleet) {
      params.push(norm(req.query.fleet));
      conditions.push(`upper(trim(coalesce(fleet_number,''))) = upper($${params.length})`);
    }
    if (req.query.registration) {
      params.push(norm(req.query.registration));
      conditions.push(`upper(trim(coalesce(registration,''))) = upper($${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT id, fleet_number, registration, alert_types, signal_codes, is_active, notes,
              created_by, created_at, updated_at
       FROM vehicle_alert_overrides ${where}
       ORDER BY (coalesce(fleet_number,'') || coalesce(registration,'')) ASC, id ASC`,
      params
    );
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /vehicle-overrides/vehicles — the vehicle registry for the pickers.
// Reads Supabase `vehiclesc` (registration_number + fleet_number), capped.
router.get('/vehicles', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '2000'), 10) || 2000, 1), 5000);
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(500).json({ success: false, message: 'Supabase not configured' });
    }
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from('vehiclesc')
      .select('registration_number, fleet_number')
      .limit(limit);
    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
    const rows = (data || [])
      .map((r) => ({
        registration_number: String(r?.registration_number || '').trim(),
        fleet_number: String(r?.fleet_number || '').trim(),
      }))
      .filter((r) => r.registration_number || r.fleet_number);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /vehicle-overrides/alert-types — selectable alert statuses.
router.get('/alert-types', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.name, d.signal_code, d.category, d.description, d.is_active
       FROM alert_definitions d
       ORDER BY d.category ASC, d.name ASC`
    );
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /vehicle-overrides — create (or replace the row for the same vehicle).
router.post('/', async (req, res) => {
  try {
    const fleet = norm(req.body?.fleet_number);
    const registration = norm(req.body?.registration);
    if (!fleet && !registration) {
      return res.status(400).json({ success: false, message: 'fleet_number or registration is required' });
    }
    const alertTypes = toArray(req.body?.alert_types);
    const signalCodes = toArray(req.body?.signal_codes);
    if (alertTypes.length === 0 && signalCodes.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one alert status' });
    }
    const { rows } = await db.query(
      `INSERT INTO vehicle_alert_overrides
         (fleet_number, registration, alert_types, signal_codes, is_active, notes, created_by, updated_at)
       VALUES ($1, NULLIF($2,''), $3::text[], $4::text[], $5, $6, $7, NOW())
       ON CONFLICT (COALESCE(fleet_number,''), COALESCE(registration,''))
       DO UPDATE SET
         alert_types = EXCLUDED.alert_types,
         signal_codes = EXCLUDED.signal_codes,
         is_active = EXCLUDED.is_active,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING id, fleet_number, registration, alert_types, signal_codes, is_active, notes,
                 created_by, created_at, updated_at`,
      [fleet, registration, alertTypes, signalCodes, req.body?.is_active !== false, norm(req.body?.notes) || null, norm(req.body?.created_by) || null]
    );
    await overrides.invalidate();
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /vehicle-overrides/:id
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const alertTypes = toArray(req.body?.alert_types);
    const signalCodes = toArray(req.body?.signal_codes);
    if (alertTypes.length === 0 && signalCodes.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one alert status' });
    }
    const { rows } = await db.query(
      `UPDATE vehicle_alert_overrides
       SET fleet_number = NULLIF($2,''), registration = NULLIF($3,''),
           alert_types = $4::text[], signal_codes = $5::text[],
           is_active = $6, notes = $7, updated_at = NOW()
       WHERE id = $1
       RETURNING id, fleet_number, registration, alert_types, signal_codes, is_active, notes,
                 created_by, created_at, updated_at`,
      [id, norm(req.body?.fleet_number), norm(req.body?.registration), alertTypes, signalCodes,
       req.body?.is_active !== false, norm(req.body?.notes) || null]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
    await overrides.invalidate();
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /vehicle-overrides/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const { rows } = await db.query('DELETE FROM vehicle_alert_overrides WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
    await overrides.invalidate();
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
