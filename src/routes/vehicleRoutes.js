const express = require('express');
const db = require('../db');

const router = express.Router();

const ADMIN_ROLES = new Set(['admin', 'administrator', 'super admin', 'energyrite_admin']);
const norm = (value) => String(value == null ? '' : value).trim();

function isAdmin(req) {
  return ADMIN_ROLES.has(String(req.userRole || '').trim().toLowerCase());
}

function canEditVehicles(req) {
  const permissions = Array.isArray(req.userPermissions) ? req.userPermissions : [];
  return permissions.some((permission) => {
    if (!permission || typeof permission !== 'object') return false;
    if (norm(permission.page).toLowerCase() !== 'vehicles') return false;
    return Array.isArray(permission.actions)
      && permission.actions.map((action) => norm(action).toLowerCase()).includes('edit');
  });
}

// Adding a vehicle is allowed for admins and anyone with create/edit/write on
// the Vehicles page. `write` is accepted in case a custom permission uses it;
// the built-in permission model uses create/edit.
function canCreateVehicles(req) {
  const permissions = Array.isArray(req.userPermissions) ? req.userPermissions : [];
  return permissions.some((permission) => {
    if (!permission || typeof permission !== 'object') return false;
    if (norm(permission.page).toLowerCase() !== 'vehicles') return false;
    if (!Array.isArray(permission.actions)) return false;
    const actions = permission.actions.map((action) => norm(action).toLowerCase());
    return actions.includes('create') || actions.includes('edit') || actions.includes('write');
  });
}

async function broadcastVehicleEvent(event, payload, timeoutMs = 3000) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !payload) return false;

  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ topic: 'vehiclesc-updates', event, payload }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  } catch (error) {
    console.error(`[VEHICLES] Realtime ${event} broadcast failed:`, error.message);
    return false;
  }
}

// POST /api/vehicles/add
//
// Adds a vehicle to Supabase (dashboard source) and then to the local fleet
// registry in the background so the registry write never blocks the add.
router.post('/add', async (req, res) => {
  try {
    if (!isAdmin(req) && !canCreateVehicles(req)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to add vehicles' });
    }

    const fleetNumber = norm(req.body?.fleet_number);
    const registrationNumber = norm(req.body?.registration_number);
    const costCenterId = Number(req.body?.cost_center_id);

    if (!fleetNumber) {
      return res.status(400).json({ success: false, message: 'Fleet number is required', field: 'fleet_number' });
    }
    if (!registrationNumber) {
      return res.status(400).json({ success: false, message: 'Registration number is required', field: 'registration_number' });
    }
    if (!Number.isInteger(costCenterId) || costCenterId <= 0) {
      return res.status(400).json({ success: false, message: 'Cost centre is required', field: 'cost_center_id' });
    }

    const { rows: costCenters } = await db.query(
      'SELECT name FROM cost_centers WHERE id = $1 LIMIT 1',
      [costCenterId]
    );
    if (costCenters.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Selected cost centre was not found. Please refresh and try again',
        field: 'cost_center_id',
      });
    }
    const costCenterName = norm(costCenters[0].name);

    const local = await db.query(
      `SELECT 1 FROM fleet_vehicles
        WHERE UPPER(TRIM(fleet_number)) = UPPER(TRIM($1))
        LIMIT 1`,
      [fleetNumber]
    );
    if (local.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A vehicle with fleet number "${fleetNumber}" already exists`,
        field: 'fleet_number',
      });
    }

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(500).json({ success: false, message: 'Vehicle database is not configured' });
    }

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(url, key);

    const { data: fleetRows, error: fleetError } = await supabase
      .from('vehiclesc')
      .select('id')
      .ilike('fleet_number', fleetNumber)
      .limit(1);
    if (fleetError) {
      console.error('[VEHICLES] Add fleet check failed:', fleetError.message);
      return res.status(502).json({ success: false, message: 'Could not add vehicle. Please try again' });
    }
    if (Array.isArray(fleetRows) && fleetRows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A vehicle with fleet number "${fleetNumber}" already exists`,
        field: 'fleet_number',
      });
    }

    const { data: inserted, error: insertError } = await supabase
      .from('vehiclesc')
      .insert({
        ...(req.body || {}),
        fleet_number: fleetNumber,
        registration_number: registrationNumber,
        cost_center_id: costCenterId,
        cost_center: costCenterName,
        cost_centres: costCenterName,
      })
      .select('id, fleet_number, registration_number, cost_center_id, cost_centres, driver_id')
      .single();

    if (insertError) {
      console.error('[VEHICLES] Add Supabase insert failed:', insertError.message);
      return res.status(502).json({ success: false, message: 'Could not add vehicle. Please try again' });
    }

    // Must reach every open dashboard before this request succeeds.
    await broadcastVehicleEvent('INSERT', {
      id: inserted?.id ?? null,
      fleet_number: fleetNumber,
      registration_number: registrationNumber,
      cost_center_id: costCenterId,
      cost_center: costCenterName,
      cost_centres: costCenterName,
      driver_id: inserted?.driver_id ?? (req.body?.driver_id ?? null),
    });

    res.status(201).json({ success: true, vehicle: inserted });

    setImmediate(() => {
      db.insertFleetVehicle({
        fleetNumber,
        registrationNumber,
        costCenterId,
        costCenter: costCenterName,
      })
        .then(() => {
          require('../services/costCenterLookup').invalidateVehicleCostCenter(fleetNumber);
          require('../vehicles/identity').invalidate();
        })
        .catch((error) => {
          console.error('[VEHICLES] Background fleet_vehicles insert failed:', error.message);
        });
    });
  } catch (error) {
    console.error('[VEHICLES] Add vehicle failed:', error.message);
    return res.status(500).json({ success: false, message: 'Could not add vehicle. Please try again' });
  }
});

// PATCH /api/vehicles/update
//
// Single backend update for the Vehicles edit form. Supabase is updated by the
// service role (no browser auth-lock/abort path) and the local fleet registry is
// only touched when the cost centre changes.
router.patch('/update', async (req, res) => {
  try {
    if (!isAdmin(req) && !canEditVehicles(req)) {
      return res.status(403).json({ success: false, message: 'Vehicles edit permission required' });
    }

    const requestedFleet = norm(req.body?.fleet_number);
    if (!requestedFleet) {
      return res.status(400).json({ success: false, message: 'Fleet number is required', field: 'fleet_number' });
    }
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'cost_center_id')) {
      return res.status(400).json({ success: false, message: 'Cost centre is required', field: 'cost_center_id' });
    }

    const rawCcId = req.body?.cost_center_id;
    const costCenterId = rawCcId == null || rawCcId === '' ? null : Number(rawCcId);
    if (costCenterId != null && (!Number.isInteger(costCenterId) || costCenterId <= 0)) {
      return res.status(400).json({ success: false, message: 'Cost centre is invalid', field: 'cost_center_id' });
    }

    let costCenterName = null;
    if (costCenterId != null) {
      const { rows } = await db.query('SELECT name FROM cost_centers WHERE id = $1 LIMIT 1', [costCenterId]);
      if (rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Selected cost centre was not found. Please refresh and try again',
          field: 'cost_center_id',
        });
      }
      costCenterName = norm(rows[0].name) || null;
    }

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(500).json({ success: false, message: 'Vehicle database is not configured' });
    }

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(url, key);
    const vehicleId = req.body?.vehicle_id == null ? null : Number(req.body.vehicle_id);

    let currentQuery = supabase
      .from('vehiclesc')
      .select('id, fleet_number, registration_number, cost_center_id, cost_center, cost_centres');
    currentQuery = Number.isInteger(vehicleId) && vehicleId > 0
      ? currentQuery.eq('id', vehicleId)
      : currentQuery.eq('fleet_number', requestedFleet);

    const { data: current, error: currentError } = await currentQuery.maybeSingle();
    if (currentError) {
      console.error('[VEHICLES] Update lookup failed:', currentError.message);
      return res.status(502).json({ success: false, message: 'Could not update vehicle. Please try again' });
    }
    if (!current) {
      return res.status(404).json({ success: false, message: `Fleet ${requestedFleet} not found` });
    }

    const fleetNumber = norm(current.fleet_number) || requestedFleet;
    const registrationNumber = Object.prototype.hasOwnProperty.call(req.body || {}, 'registration_number')
      ? (norm(req.body.registration_number) || null)
      : (norm(current.registration_number) || null);
    const oldCostCenterId = current.cost_center_id == null ? null : Number(current.cost_center_id);
    const oldCostCenterName = norm(current.cost_center ?? current.cost_centres) || null;
    const costCenterChanged = (oldCostCenterId ?? null) !== (costCenterId ?? null);

    if (costCenterChanged) {
      const updatedRows = await db.updateFleetVehicleCostCenter({
        fleetNumber,
        costCenterId,
        costCenter: costCenterName,
      });
      if (updatedRows.length === 0) {
        return res.status(404).json({ success: false, message: `Fleet ${fleetNumber} not found in fleet_vehicles` });
      }
    }

    const { vehicle_id, id, created_at, updated_at, cost_center, cost_centres, ...body } = req.body || {};
    const update = {
      ...body,
      fleet_number: fleetNumber,
      registration_number: registrationNumber,
      cost_center_id: costCenterId,
      cost_center: costCenterName,
      cost_centres: costCenterName,
    };

    const { data: updated, error: updateError } = await supabase
      .from('vehiclesc')
      .update(update)
      .eq('id', current.id)
      .select('id, fleet_number, registration_number, cost_center_id, cost_centres')
      .single();

    if (updateError) {
      if (costCenterChanged) {
        await db.updateFleetVehicleCostCenter({
          fleetNumber,
          costCenterId: oldCostCenterId,
          costCenter: oldCostCenterName,
        }).catch((error) => {
          console.error('[VEHICLES] Cost-centre rollback failed:', error.message);
        });
      }
      console.error('[VEHICLES] Update Supabase write failed:', updateError.message);
      return res.status(502).json({ success: false, message: 'Could not update vehicle. Please try again' });
    }

    require('../vehicles/identity').invalidate();

    const broadcastPayload = costCenterChanged
      ? {
          fleet_number: fleetNumber,
          registration_number: updated.registration_number ?? registrationNumber,
          cost_center_id: costCenterId,
          cost_center: costCenterName,
        }
      : null;

    if (costCenterChanged) {
      require('../services/costCenterLookup').invalidateVehicleCostCenter(fleetNumber);
      require('../services/soltrackClient').refreshFleetDict().catch((error) => {
        console.error('[VEHICLES] Soltrack fleet dict refresh failed:', error.message);
      });
    }

    res.json({ success: true, vehicle: updated });

    // The save must not wait on Realtime. Broadcast immediately after the
    // response so every listener still updates without a refresh.
    if (broadcastPayload) {
      setImmediate(() => {
        void broadcastVehicleEvent('UPDATE', broadcastPayload, 10000);
      });
    }
    return;
  } catch (error) {
    console.error('[VEHICLES] Update vehicle failed:', error.message);
    return res.status(500).json({ success: false, message: 'Could not update vehicle. Please try again' });
  }
});

// PATCH /api/vehicles/:fleetNumber/cost-center
//
// Cost centre is the only vehicle field that must exist in BOTH systems:
// Supabase `vehiclesc` (dashboard/reference source) and Postgres
// `fleet_vehicles` (alerts, reporting, self-monitoring). The frontend calls
// this first when the cost centre changes, then updates the remaining
// non-cost-centre Supabase fields. Supabase Realtime broadcasts the CC update
// to every open client.
router.patch('/:fleetNumber/cost-center', async (req, res) => {
  try {
    if (!isAdmin(req) && !canEditVehicles(req)) {
      return res.status(403).json({ success: false, message: 'Vehicles edit permission required' });
    }

    const fleetNumber = norm(req.params.fleetNumber);
    if (!fleetNumber) {
      return res.status(400).json({ success: false, message: 'fleetNumber is required' });
    }

    const rawCcId = req.body?.cost_center_id;
    const costCenterId = rawCcId == null || rawCcId === '' ? null : Number(rawCcId);
    if (costCenterId != null && (!Number.isInteger(costCenterId) || costCenterId <= 0)) {
      return res.status(400).json({ success: false, message: 'cost_center_id must be a positive integer or null' });
    }

    let costCenterName = null;
    if (costCenterId != null) {
      const { rows } = await db.query('SELECT name FROM cost_centers WHERE id = $1 LIMIT 1', [costCenterId]);
      if (rows.length === 0) {
        return res.status(400).json({ success: false, message: `Cost centre ${costCenterId} not found` });
      }
      costCenterName = norm(rows[0].name) || null;
    }

    const before = await db.query(
      `SELECT fleet_number, registration_number, cost_center, cost_center_id
         FROM fleet_vehicles
        WHERE UPPER(TRIM(fleet_number)) = UPPER(TRIM($1))`,
      [fleetNumber]
    );
    if (before.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Fleet ${fleetNumber} not found in fleet_vehicles` });
    }

    const oldCostCenter = before.rows[0].cost_center ?? null;
    const oldCostCenterId = before.rows[0].cost_center_id ?? null;

    const updated = await db.updateFleetVehicleCostCenter({
      fleetNumber,
      costCenterId,
      costCenter: costCenterName,
    });

    // Mirror into Supabase so the app/dashboard and Realtime stay consistent.
    try {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error('Supabase is not configured');

      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(url, key);
      let query = supabase
        .from('vehiclesc')
        .update({
          cost_center_id: costCenterId,
          cost_center: costCenterName,
          cost_centres: costCenterName,
        });

      const vehicleId = req.body?.vehicle_id == null ? null : Number(req.body.vehicle_id);
      query = Number.isInteger(vehicleId) && vehicleId > 0
        ? query.eq('id', vehicleId)
        : query.eq('fleet_number', fleetNumber);

      const { error } = await query;
      if (error) throw new Error(error.message);
    } catch (supabaseError) {
      // Keep the two registries aligned: undo the Postgres write.
      await db.query(
        `UPDATE fleet_vehicles
            SET cost_center = $2, cost_center_id = $3, updated_at = NOW()
          WHERE UPPER(TRIM(fleet_number)) = UPPER(TRIM($1))`,
        [fleetNumber, oldCostCenter, oldCostCenterId]
      ).catch(() => {});
      console.error('[VEHICLES] Cost-centre Supabase mirror failed:', supabaseError.message);
      return res.status(502).json({ success: false, message: `Could not update vehicle cost centre: ${supabaseError.message}` });
    }

    require('../services/costCenterLookup').invalidateVehicleCostCenter(fleetNumber);
    require('../vehicles/identity').invalidate();
    require('../services/soltrackClient').refreshFleetDict().catch((err) => {
      console.error('[VEHICLES] Soltrack fleet dict refresh failed:', err.message);
    });

    await broadcastVehicleEvent('UPDATE', {
      fleet_number: fleetNumber,
      registration_number: before.rows[0].registration_number || null,
      cost_center_id: costCenterId,
      cost_center: costCenterName,
    });

    return res.json({
      success: true,
      fleet_number: fleetNumber,
      cost_center_id: costCenterId,
      cost_center: costCenterName,
      updated,
    });
  } catch (error) {
    console.error('[VEHICLES] Cost-centre update failed:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
