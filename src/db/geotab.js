const { query } = require('./pool');

// ── Helpers ──

function extractFleetNumber(name) {
  const cleaned = (name || '').trim();
  const match = cleaned.match(/^([A-Za-z0-9]+)\s*[-–]/);
  return match ? match[1] : (cleaned || null);
}

function parseDuration(durationStr) {
  if (!durationStr) return null;
  const parts = durationStr.split(':');
  if (parts.length !== 3) return null;
  const hours = parseFloat(parts[0]) || 0;
  const minutes = parseFloat(parts[1]) || 0;
  const seconds = parseFloat(parts[2]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

// ── Geotab Devices ──

async function upsertGeotabDevices(devices) {
  if (!devices || devices.length === 0) return;
  const batchSize = 100;
  for (let i = 0; i < devices.length; i += batchSize) {
    const batch = devices.slice(i, i + batchSize);
    const values = batch.map((_, idx) => {
      const base = idx * 15;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
    }).join(', ');

    const params = batch.flatMap(d => [
      d.id,
      d.name,
      d.fleet_number || extractFleetNumber(d.name),
      d.license_plate || null,
      d.device_type || null,
      d.vin || null,
      d.serial_number || null,
      d.fuel_tank_capacity || null,
      d.timezone || null,
      d.is_active !== false,
      d.active_from || null,
      d.active_to || null,
      JSON.stringify(d.groups || []),
      JSON.stringify(d.raw_data || {}),
      new Date(),
    ]);

    await query(
      `INSERT INTO geotab_devices
       (id, name, fleet_number, license_plate, device_type, vin, serial_number,
        fuel_tank_capacity, timezone, is_active, active_from, active_to,
        groups, raw_data, last_synced)
       VALUES ${values}
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         fleet_number = EXCLUDED.fleet_number,
         license_plate = EXCLUDED.license_plate,
         device_type = EXCLUDED.device_type,
         vin = EXCLUDED.vin,
         serial_number = EXCLUDED.serial_number,
         fuel_tank_capacity = EXCLUDED.fuel_tank_capacity,
         timezone = EXCLUDED.timezone,
         is_active = EXCLUDED.is_active,
         active_from = EXCLUDED.active_from,
         active_to = EXCLUDED.active_to,
         groups = EXCLUDED.groups,
         raw_data = EXCLUDED.raw_data,
         last_synced = EXCLUDED.last_synced,
         updated_at = NOW()`,
      params
    );
  }
}

async function getGeotabDevice(id) {
  const result = await query('SELECT * FROM geotab_devices WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getGeotabDeviceByFleet(fleetNumber) {
  const result = await query(
    'SELECT * FROM geotab_devices WHERE fleet_number = $1 LIMIT 1',
    [fleetNumber]
  );
  return result.rows[0] || null;
}

async function getGeotabDeviceByPlate(licensePlate) {
  const result = await query(
    'SELECT * FROM geotab_devices WHERE license_plate = $1 LIMIT 1',
    [licensePlate.trim()]
  );
  return result.rows[0] || null;
}

async function getAllGeotabDevices() {
  const result = await query('SELECT * FROM geotab_devices ORDER BY name');
  return result.rows;
}

async function getActiveGeotabDevices() {
  const result = await query(
    `SELECT * FROM geotab_devices
     WHERE is_active = TRUE AND (active_to IS NULL OR active_to > NOW())
     ORDER BY name`
  );
  return result.rows;
}

// ── Geotab Groups ──

async function upsertGeotabGroups(groups) {
  if (!groups || groups.length === 0) return;
  const values = groups.map((_, idx) => {
    const base = idx * 6;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  }).join(', ');

  const params = groups.flatMap(g => [
    g.id,
    g.name,
    g.parent_id || null,
    g.is_global || false,
    JSON.stringify(g.raw_data || {}),
    new Date(),
  ]);

  await query(
    `INSERT INTO geotab_groups (id, name, parent_id, is_global, raw_data, last_synced)
     VALUES ${values}
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       parent_id = EXCLUDED.parent_id,
       is_global = EXCLUDED.is_global,
       raw_data = EXCLUDED.raw_data,
       last_synced = EXCLUDED.last_synced`,
    params
  );
}

async function getGeotabGroup(id) {
  const result = await query('SELECT * FROM geotab_groups WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getAllGeotabGroups() {
  const result = await query('SELECT * FROM geotab_groups ORDER BY name');
  return result.rows;
}

// ── Exception Rules ──

async function upsertExceptionRules(rules) {
  if (!rules || rules.length === 0) return;
  const values = rules.map((_, idx) => {
    const base = idx * 5;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  }).join(', ');

  const params = rules.flatMap(r => [
    r.id,
    r.name,
    r.description || null,
    JSON.stringify(r.raw_data || {}),
    new Date(),
  ]);

  await query(
    `INSERT INTO geotab_exception_rules (id, name, description, raw_data, last_synced)
     VALUES ${values}
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       raw_data = EXCLUDED.raw_data,
       last_synced = EXCLUDED.last_synced`,
    params
  );
}

async function getExceptionRule(id) {
  const result = await query('SELECT * FROM geotab_exception_rules WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getAllExceptionRules() {
  const result = await query('SELECT * FROM geotab_exception_rules ORDER BY name');
  return result.rows;
}

// ── Diagnostics ──

async function upsertDiagnostics(diagnostics) {
  if (!diagnostics || diagnostics.length === 0) return;
  const batchSize = 50;
  for (let i = 0; i < diagnostics.length; i += batchSize) {
    const batch = diagnostics.slice(i, i + batchSize).filter(d => d.id && d.name);
    if (batch.length === 0) continue;
    const values = batch.map((_, idx) => {
      const base = idx * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    }).join(', ');

    const params = batch.flatMap(d => [
      d.id,
      d.name,
      d.unit || null,
      JSON.stringify(d.raw_data || {}),
      new Date(),
    ]);

    await query(
      `INSERT INTO geotab_diagnostics (id, name, unit, raw_data, last_synced)
       VALUES ${values}
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         unit = EXCLUDED.unit,
         raw_data = EXCLUDED.raw_data,
         last_synced = EXCLUDED.last_synced`,
      params
    ).catch(err => console.error('[GEOTAB] Diagnostics batch error:', err.message));
  }
}

async function getDiagnostic(id) {
  if (!id || id === 'NoDiagnosticId') return null;
  const result = await query('SELECT * FROM geotab_diagnostics WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// ── Fleet Vehicles (synced from Supabase) ──

async function upsertFleetVehicles(vehicles) {
  if (!vehicles || vehicles.length === 0) return;

  // Resolve cost center names/codes to ids
  let ccMap = new Map();
  try {
    const ccResult = await query('SELECT id, name, code FROM cost_centers');
    for (const cc of ccResult.rows) {
      if (cc.name) ccMap.set(String(cc.name).toLowerCase(), cc.id);
      if (cc.code) ccMap.set(String(cc.code).toLowerCase(), cc.id);
    }
  } catch (err) {
    console.error('[GEOTAB] Failed to resolve cost centers:', err.message);
  }

  // Deduplicate by fleet_number + registration_number (keep last occurrence)
  const uniqueMap = new Map();
  for (const v of vehicles) {
    const key = `${v.fleet_number || ''}:${v.registration_number || ''}`;
    uniqueMap.set(key, v);
  }
  const uniqueVehicles = Array.from(uniqueMap.values());

  const batchSize = 100;
  for (let i = 0; i < uniqueVehicles.length; i += batchSize) {
    const batch = uniqueVehicles.slice(i, i + batchSize);
    const values = batch.map((_, idx) => {
      const base = idx * 7;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    }).join(', ');

    const params = batch.flatMap(v => [
      v.fleet_number || null,
      v.registration_number || null,
      v.make || null,
      v.model || null,
      v.cost_center || null,
      (v.cost_center && ccMap.get(String(v.cost_center).toLowerCase())) || v.cost_center_id || null,
      new Date(),
    ]);

    await query(
      `INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center, cost_center_id, last_synced)
       VALUES ${values}
       ON CONFLICT (fleet_number, registration_number) DO UPDATE SET
         make = EXCLUDED.make,
         model = EXCLUDED.model,
         cost_center = EXCLUDED.cost_center,
         cost_center_id = EXCLUDED.cost_center_id,
         last_synced = EXCLUDED.last_synced,
         updated_at = NOW()`,
      params
    );
  }
}

async function getFleetVehicleByFleet(fleetNumber) {
  const result = await query(
    'SELECT * FROM fleet_vehicles WHERE fleet_number = $1 LIMIT 1',
    [fleetNumber]
  );
  return result.rows[0] || null;
}

async function getFleetVehicleByReg(registrationNumber) {
  const result = await query(
    'SELECT * FROM fleet_vehicles WHERE registration_number = $1 LIMIT 1',
    [registrationNumber.trim()]
  );
  return result.rows[0] || null;
}

async function getAllFleetVehicles() {
  const result = await query('SELECT * FROM fleet_vehicles ORDER BY fleet_number, registration_number');
  return result.rows;
}

async function isFleetVehicle(fleetNumber, registrationNumber) {
  if (fleetNumber) {
    const result = await query(
      'SELECT 1 FROM fleet_vehicles WHERE fleet_number = $1 LIMIT 1',
      [fleetNumber]
    );
    if (result.rows.length > 0) return true;
  }
  if (registrationNumber) {
    const result = await query(
      'SELECT 1 FROM fleet_vehicles WHERE registration_number = $1 LIMIT 1',
      [registrationNumber.trim()]
    );
    if (result.rows.length > 0) return true;
  }
  return false;
}

// ── Geotab Zones ──

async function upsertGeotabZones(zones) {
  if (!zones || zones.length === 0) return;
  for (const zone of zones) {
    const name = (zone.name || '').toUpperCase();
    const isHighRisk = name.includes('HIGH RISK');
    const isNoGo = name.includes('NO GO');
    await query(
      `INSERT INTO geotab_zones (id, name, points, zone_types, comment, is_high_risk, is_no_go, raw_data, last_synced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, points = EXCLUDED.points, zone_types = EXCLUDED.zone_types,
         comment = EXCLUDED.comment, is_high_risk = EXCLUDED.is_high_risk, is_no_go = EXCLUDED.is_no_go,
         raw_data = EXCLUDED.raw_data, last_synced = NOW()`,
      [
        zone.id,
        zone.name || null,
        JSON.stringify(zone.points || []),
        JSON.stringify(zone.zoneTypes || []),
        zone.comment || null,
        isHighRisk,
        isNoGo,
        JSON.stringify(zone),
      ]
    );
  }
}

async function getGeotabZones() {
  const result = await query('SELECT * FROM geotab_zones ORDER BY name');
  return result.rows;
}

async function getHighRiskZones() {
  const result = await query('SELECT * FROM geotab_zones WHERE is_high_risk = TRUE OR is_no_go = TRUE ORDER BY name');
  return result.rows;
}

// ── Vehicle Log Records ──

async function upsertVehicleLogRecords(records) {
  if (!records || records.length === 0) return;
  for (const rec of records) {
    await query(
      `INSERT INTO vehicle_log_records (device_id, latitude, longitude, speed, heading, odometer, record_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (device_id, record_time) DO NOTHING`,
      [rec.deviceId, rec.latitude, rec.longitude, rec.speed, rec.heading, rec.odometer, rec.recordTime]
    ).catch(() => {});
  }
}

async function getVehicleLogRecords(deviceId, from, to) {
  const result = await query(
    'SELECT * FROM vehicle_log_records WHERE device_id = $1 AND record_time BETWEEN $2 AND $3 ORDER BY record_time ASC',
    [deviceId, from, to]
  );
  return result.rows;
}

async function getLatestLogRecord(deviceId) {
  const result = await query(
    'SELECT * FROM vehicle_log_records WHERE device_id = $1 ORDER BY record_time DESC LIMIT 1',
    [deviceId]
  );
  return result.rows[0] || null;
}

// ── Vehicle Status ──

async function upsertVehicleStatus(deviceId, data) {
  // Upsert only the fields provided in `data`. Because all dynamic fields use COALESCE,
  // missing/null values keep the last known value instead of blanking the row.
  await query(
    `INSERT INTO vehicle_status (device_id, plate, license_plate, fleet_number, engine_on, ignition_on, speed, latitude, longitude, last_log_time, last_update)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       plate = COALESCE(EXCLUDED.plate, vehicle_status.plate),
       license_plate = COALESCE(EXCLUDED.license_plate, vehicle_status.license_plate),
       fleet_number = COALESCE(EXCLUDED.fleet_number, vehicle_status.fleet_number),
       engine_on = COALESCE(EXCLUDED.engine_on, vehicle_status.engine_on),
       ignition_on = COALESCE(EXCLUDED.ignition_on, vehicle_status.ignition_on),
       speed = COALESCE(EXCLUDED.speed, vehicle_status.speed),
       latitude = COALESCE(EXCLUDED.latitude, vehicle_status.latitude),
       longitude = COALESCE(EXCLUDED.longitude, vehicle_status.longitude),
       last_log_time = COALESCE(EXCLUDED.last_log_time, vehicle_status.last_log_time),
       last_update = NOW()`,
    [
      deviceId,
      data.plate || null,
      data.licensePlate || null,
      data.fleetNumber || null,
      data.engineOn ?? null,
      data.ignitionOn ?? null,
      data.speed ?? null,
      data.latitude ?? null,
      data.longitude ?? null,
      data.lastLogTime || null,
    ]
  ).catch(() => {});
}

async function getVehicleStatus(deviceId) {
  const result = await query('SELECT * FROM vehicle_status WHERE device_id = $1', [deviceId]);
  return result.rows[0] || null;
}

async function getAllVehicleStatus() {
  const result = await query('SELECT * FROM vehicle_status ORDER BY fleet_number, plate');
  return result.rows;
}

// ── High Risk Zone Entries ──

async function insertZoneEntry(entry) {
  const result = await query(
    `INSERT INTO high_risk_zone_entries (device_id, fleet_number, license_plate, zone_id, zone_name, risk_level, latitude, longitude, speed, entry_time, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
     RETURNING id`,
    [
      entry.deviceId,
      entry.fleetNumber || null,
      entry.licensePlate || null,
      entry.zoneId,
      entry.zoneName,
      entry.riskLevel,
      entry.latitude,
      entry.longitude,
      entry.speed ?? null,
      entry.entryTime,
    ]
  );
  return result.rows[0] || null;
}

async function getActiveZoneEntries(deviceId) {
  const result = await query(
    'SELECT * FROM high_risk_zone_entries WHERE device_id = $1 AND is_active = TRUE ORDER BY entry_time DESC',
    [deviceId]
  );
  return result.rows;
}

async function getZoneEntries(deviceId, from, to) {
  let q = 'SELECT * FROM high_risk_zone_entries WHERE 1=1';
  const params = [];
  let idx = 1;
  if (deviceId) { q += ` AND device_id = $${idx}`; params.push(deviceId); idx++; }
  if (from) { q += ` AND entry_time >= $${idx}`; params.push(from); idx++; }
  if (to) { q += ` AND entry_time <= $${idx}`; params.push(to); idx++; }
  q += ' ORDER BY entry_time DESC';
  const result = await query(q, params);
  return result.rows;
}

async function getAllActiveZoneEntries() {
  const result = await query(
    `SELECT h.*, gz.name as zone_name_full
     FROM high_risk_zone_entries h
     LEFT JOIN geotab_zones gz ON gz.id = h.zone_id
     WHERE h.is_active = TRUE
     ORDER BY h.entry_time DESC`
  );
  return result.rows;
}

module.exports = {
  extractFleetNumber,
  parseDuration,
  upsertGeotabDevices,
  getGeotabDevice,
  getGeotabDeviceByFleet,
  getGeotabDeviceByPlate,
  getAllGeotabDevices,
  getActiveGeotabDevices,
  upsertGeotabGroups,
  getGeotabGroup,
  getAllGeotabGroups,
  upsertExceptionRules,
  getExceptionRule,
  getAllExceptionRules,
  upsertDiagnostics,
  getDiagnostic,
  upsertFleetVehicles,
  getFleetVehicleByFleet,
  getFleetVehicleByReg,
  getAllFleetVehicles,
  isFleetVehicle,
  upsertGeotabZones,
  getGeotabZones,
  getHighRiskZones,
  upsertVehicleLogRecords,
  getVehicleLogRecords,
  getLatestLogRecord,
  upsertVehicleStatus,
  getVehicleStatus,
  getAllVehicleStatus,
  insertZoneEntry,
  getActiveZoneEntries,
  getZoneEntries,
  getAllActiveZoneEntries,
};
