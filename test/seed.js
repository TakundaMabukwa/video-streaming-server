'use strict';
// Local test fixture: the definition catalogue and vehicles used by the
// existing root-level tests. Run against a disposable local DATABASE_URL.
const db = require('../src/db');

const DEFS = [
  ['Driver Fatigue 3h (Low)', 'telematics', 'a43F6lFwgIUq_gkgmgSX08g', 'MEDIUM'],
  ['Driver Fatigue 6h (Medium)', 'telematics', 'aScBH27NHXUqTLcl8QcCo4g', 'HIGH'],
  ['8 Hour Duration Check', 'telematics', 'aXmPcWqFx3kKp1XKdQDQEYQ', 'MEDIUM'],
  ['Driver fatigue 9h (High)', 'telematics', 'adT7lgnAOhEep8a1M4u09eg', 'CRITICAL'],
  ['12 Hour Duration Check', 'telematics', 'aJ2f9avKM80Ch7JgyCqOl7A', 'HIGH'],
  ['15 Hour Duration Check', 'telematics', 'aTZcSSADJ60eeqxk2DNGkZA', 'CRITICAL'],
  ['Entering High Risk Area', 'telematics', 'aCmnsH92P1kqGBTWyRmdacA', 'CRITICAL'],
  ['No-Go Zone Entry', 'telematics', 'noGoZoneEntry', 'CRITICAL'],
  ['No Stopping Zone Entry', 'telematics', 'noStoppingZoneEntry', 'HIGH'],
  ['Approaching Zone', 'telematics', 'zone-approaching', 'HIGH'],
  ['Stopped High Risk area', 'telematics', 'aKW3NJEDtS0OpMwwVlTHWJQ', 'CRITICAL'],
  ['Stopped > 1min High Risk', 'telematics', 'aCOAc4GcoSkKgsIS9Qnb7mA', 'CRITICAL'],
  ['Stopped > 1min No Stopping', 'telematics', 'aUg2ERYlb3UChMJWTat0fKw', 'HIGH'],
  ['Heavy Duty Max Speeding 85km/h', 'telematics', 'aURw7fNBdxEGWY3NXil_yIg', 'HIGH'],
  ['Heavy Duty Max Speeding 90KM/H', 'telematics', 'aLv1Bv53LBkClq5rSQ5QPkQ', 'HIGH'],
  ['Cellphone Use', 'video', 'handheldPhoneCall', 'HIGH'],
  ['Harsh Braking', 'telematics', 'harshBraking', 'MEDIUM'],
  ['Reckless Driving', 'telematics', 'recklessDriving', 'HIGH'],
  ['Seatbelt Violation', 'video', 'seatBelt', 'MEDIUM'],
  ['Distracted Driving', 'video', 'driverDistracted', 'HIGH'],
  ['Bang', 'video', 'bang', 'CRITICAL'],
];

const FLEETS = [
  ['OT22', 'LCZ729MP'],
  ['VT06', 'JGV566FS'],
  ['EX55', 'LDR065MP'],
  ['FM10', 'LDG067MP'],
  ['LH29', 'LDG368MP'],
];

async function seed() {
  await db.initializeDatabase();
  for (const [name, category, code, severity] of DEFS) {
    await db.query(
      `INSERT INTO alert_definitions (name, category, signal_code, severity, is_active, is_global)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (signal_code) DO UPDATE SET
         name = EXCLUDED.name, category = EXCLUDED.category,
         severity = EXCLUDED.severity, is_active = true, is_global = true`,
      [name, category, code, severity]
    );
  }
  for (const [fleet, reg] of FLEETS) {
    await db.query(
      `INSERT INTO fleet_vehicles (fleet_number, registration_number)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [fleet, reg]
    );
  }
  console.log(`seeded ${DEFS.length} definitions and ${FLEETS.length} fleets`);
}

module.exports = { seed, DEFS, FLEETS };

if (require.main === module) {
  seed()
    .then(() => db.closePool())
    .catch((err) => { console.error(err); process.exit(1); });
}
