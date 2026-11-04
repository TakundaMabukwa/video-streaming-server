// Local-only test bootstrap. Requires DATABASE_URL to point at a disposable DB.
const db = require('../src/db');

async function resetSchema() {
  if (!/test|localhost|127\.0\.0\.1/i.test(String(process.env.DATABASE_URL || ''))) {
    throw new Error('Refusing to reset a non-local database');
  }
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await db.initializeDatabase();
}

async function seedBase() {
  await db.query(
    "INSERT INTO cost_centers (id, name, code, is_active) VALUES (5, 'CC5', 'C5', true), (6, 'CC6', 'C6', true)"
  );
  await db.query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, mettax_device_id, cost_center_id)
     VALUES ('EX55', 'LDR065MP', 'CAM123', 5)`
  );
  await db.query(
    `INSERT INTO geotab_devices (id, name, fleet_number, license_plate, is_active, active_from)
     VALUES ('b651', 'EX55 - LDR065MP', 'EX55', 'LDR065MP', true, NOW())`
  );
  const def = await db.query(
    `INSERT INTO alert_definitions (name, category, signal_code, severity, is_active, is_global)
     VALUES ('Heavy Duty Max Speeding 85km/h', 'telematics', 'aURw7fNBdxEGWY3NXil_yIg', 'HIGH', true, true)
     RETURNING id`
  );
  await db.query(
    `INSERT INTO alert_definition_overrides (alert_definition_id, cost_center_id, severity, is_active)
     VALUES ($1, 5, 'HIGH', true)`,
    [def.rows[0].id]
  );
  require('../src/vehicles/identity').invalidate();
  require('../src/alerts/authorization').invalidate();
  return { definitionId: def.rows[0].id };
}

module.exports = { db, resetSchema, seedBase };
