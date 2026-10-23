// Regression test for VEHICLE ALERT OVERRIDES on the video/camera path.
//
// batchUpsertAlertGroups (used by the camera/video sync) never consulted the
// overrides at all, and it was given no fleet/registration either — so an
// override saved for a vehicle never stopped that vehicle's camera alerts.
// The camera identifies the vehicle only in the NAME ("RH23 - GGD359X") on an
// opaque device id.
//
// Covers:
//   1. camera alert on an overridden vehicle+type  -> suppressed, nothing written
//   2. same vehicle, a different alert type        -> still raises
//   3. different vehicle, same alert type          -> still raises
//   4. suppression works when only the device name carries the vehicle
//   5. explicit fleet/registration still match (telematics behaviour intact)
//   6. suppression happens BEFORE anything is written (no group, no member row)
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';

const db = require('./src/db');
const overrides = require('./src/services/vehicleAlertOverrides');
const alertGroupsDb = require('./src/db/alert_groups');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const TAG = 'ovrtest';
const CAM_A = '221087823034'; // camera device id for OVRA
const CAM_B = '221087823999'; // camera device id for OVRB

async function cleanup() {
  await db.query(`DELETE FROM vehicle_alert_overrides WHERE fleet_number LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}%`]);
  // Groups are keyed on the camera device id, which does not contain the tag.
  await db.query(`DELETE FROM alert_groups WHERE device_id = ANY($1::text[]) OR device_id LIKE $2`,
    [[CAM_A, CAM_B], `%${TAG}%`]);
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number LIKE $1`, [`${TAG}%`]);
}

// Push one camera alert through the REAL batch path the video sync uses.
async function pushCamera({ deviceId, deviceName, alarmType, alertTag }) {
  return alertGroupsDb.batchUpsertAlertGroups([{
    deviceId,
    deviceName,
    alarmType,
    alarmText: 'override test',
    alertId: `${TAG}-${alertTag}-${Date.now()}`,
    alarmTs: new Date().toISOString(),
    lat: -26.1,
    lon: 28.2,
    speed: 40,
    severity: 'high',
  }]);
}

(async () => {
  await db.initializeDatabase();
  await cleanup();

  // Two registered vehicles, each with a camera.
  const fleetA = `${TAG}A`;
  const fleetB = `${TAG}B`;
  for (const [fleet, reg] of [[fleetA, `${TAG}-AAA111`], [fleetB, `${TAG}-BBB222`]]) {
    await db.query(
      `INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center)
       VALUES ($1, $2, 'Test', 'Test', 'Test') ON CONFLICT DO NOTHING`,
      [fleet, reg]
    );
  }
  const nameA = `${fleetA} - ${TAG}-AAA111`;
  const nameB = `${fleetB} - ${TAG}-BBB222`;

  // Override exactly like production: vehicle + one camera alert type.
  await db.query(
    `INSERT INTO vehicle_alert_overrides (fleet_number, registration, alert_types, signal_codes, is_active)
     VALUES ($1, $2, $3, $4, TRUE)`,
    [fleetA, `${TAG}-AAA111`, ['Camera Occlusion'], ['occlusion']]
  );
  await overrides.invalidate();
  await overrides.loadOverrides();

  // 1. The overridden vehicle + type must not raise.
  const suppressedRows = await pushCamera({
    deviceId: CAM_A, deviceName: nameA, alarmType: 'Camera Occlusion', alertTag: 'sup1',
  });
  check(suppressedRows.length === 0, `overridden camera alert suppressed (got ${suppressedRows.length} rows)`);
  const g1 = await db.query(
    `SELECT 1 FROM alert_groups WHERE device_id = $1 AND alarm_type = $2`, [CAM_A, 'Camera Occlusion']
  );
  check(g1.rows.length === 0, 'no alert group written for the overridden vehicle + type');
  const a1 = await db.query(`SELECT 1 FROM alerts WHERE id LIKE $1`, [`${TAG}-sup1%`]);
  check(a1.rows.length === 0, 'no member detection row written either');

  // 4. Suppression holds when the vehicle is only known from the device name.
  const byNameOnly = await pushCamera({
    deviceId: CAM_A, deviceName: nameA, alarmType: 'Camera Occlusion', alertTag: 'sup2',
  });
  check(byNameOnly.length === 0, 'still suppressed when matched via the device name');

  // 2. Same vehicle, a DIFFERENT alert type must still raise.
  const otherType = await pushCamera({
    deviceId: CAM_A, deviceName: nameA, alarmType: 'Lane Deviation', alertTag: 'ok1',
  });
  check(otherType.length === 1, `other alert types still raise for that vehicle (got ${otherType.length})`);

  // 3. Different vehicle, same alert type must still raise.
  const otherVehicle = await pushCamera({
    deviceId: CAM_B, deviceName: nameB, alarmType: 'Camera Occlusion', alertTag: 'ok2',
  });
  check(otherVehicle.length === 1, `other vehicles still raise that type (got ${otherVehicle.length})`);

  // 5. Explicit fleet / registration matching (the telematics path) is intact.
  const explicitFleet = overrides.isSuppressedSync({
    fleetNumber: fleetA, alertName: 'Camera Occlusion',
  });
  check(explicitFleet === true, 'explicit fleet_number still matches the override');
  const explicitReg = overrides.isSuppressedSync({
    registration: `${TAG}-AAA111`, signalCode: 'occlusion',
  });
  check(explicitReg === true, 'explicit registration + signal code still matches');
  const unrelated = overrides.isSuppressedSync({
    fleetNumber: fleetB, alertName: 'Camera Occlusion',
  });
  check(unrelated === false, 'an unrelated vehicle is not suppressed');

  await cleanup();
  const left = await db.query(
    `SELECT (SELECT count(*)::int FROM vehicle_alert_overrides WHERE fleet_number LIKE $1) o,
            (SELECT count(*)::int FROM fleet_vehicles WHERE fleet_number LIKE $1) v`,
    [`${TAG}%`]
  );
  check(left.rows[0].o === 0 && left.rows[0].v === 0, `test fixtures cleaned up (overrides=${left.rows[0].o} vehicles=${left.rows[0].v})`);

  console.log(ok ? '\nOVERRIDE-OK' : '\nOVERRIDE-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('OVERRIDE-ERROR:', e);
  process.exit(1);
});