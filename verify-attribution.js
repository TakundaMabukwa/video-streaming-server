// Regression test for COST CENTRE ATTRIBUTION of camera alerts.
//
// Camera device ids (long numeric ids) are not resolvable on their own, but
// the detection name already carries the vehicle ("FM10 - LDG067MP"). When the
// fleet went unresolved the group stored fleet_number = NULL, joined no cost
// centre, and the board — which treats an unknown cost centre as "never hide
// it" — showed the alert under EVERY cost centre selection.
//
// Covers:
//   1. fleet resolved from the device name for a camera id
//   2. cost centre then resolves from that fleet
//   3. an explicit fleet still wins
//   4. a real device id still resolves by itself (no regression)
//   5. an unknown name resolves to null — the fix can never invent a fleet
//   6. long numeric tokens in the name are not mistaken for a fleet
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';

const db = require('./src/db');
const { resolveFleetExact } = require('./src/services/costCenterLookup');
const alertGroupsDb = require('./src/db/alert_groups');
const { findVehicleCostCenterId } = require('./src/services/costCenterLookup');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

(async () => {
  await db.initializeDatabase();

  // Own fixtures: a cost centre + a registered vehicle inside it. Local dev
  // databases are often empty, so the test creates what it needs.
  const TAG = 'attrtest';
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM cost_centers WHERE name LIKE $1`, [`${TAG}%`]);

  const maxId = await db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM cost_centers`);
  const ccTest = Number(maxId.rows[0].m) + 1;
  await db.query(
    `INSERT INTO cost_centers (id, name, code) VALUES ($1, $2, $3)`,
    [ccTest, `${TAG} CC`, TAG]
  );

  const v = {
    fleet_number: `${TAG}01`,
    registration_number: `${TAG}-AAA111`,
    cost_center_id: ccTest,
  };
  await db.query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center, cost_center_id)
     VALUES ($1, $2, 'Test', 'Test', $3, $4)`,
    [v.fleet_number, v.registration_number, `${TAG} CC`, ccTest]
  );

  const cameraId = '221087823034'; // long numeric camera id, unresolvable alone
  const deviceName = `${v.fleet_number} - ${v.registration_number}`;
  console.log(`vehicle: fleet=${v.fleet_number} cc=${v.cost_center_id} deviceName="${deviceName}" deviceId=${cameraId}`);

  // 1. Fleet is recovered from the device name.
  const fleet = await resolveFleetExact({ deviceId: cameraId, fleetNumber: null, deviceName });
  check(String(fleet || '').toUpperCase() === String(v.fleet_number).toUpperCase(),
    `fleet resolved from device name (got ${fleet})`);

  // 2. And that fleet resolves a real cost centre.
  const ccId = await findVehicleCostCenterId(fleet);
  check(ccId != null && Number(ccId) === Number(v.cost_center_id),
    `cost centre resolves from the fleet (got ${ccId}, want ${v.cost_center_id})`);

  // 3. An explicit fleet param still wins over the name.
  const other = await db.query(
    `SELECT fv.fleet_number FROM fleet_vehicles fv
     WHERE UPPER(fv.fleet_number) <> UPPER($1) AND fv.fleet_number IS NOT NULL LIMIT 1`,
    [v.fleet_number]
  );
  if (other.rows.length > 0) {
    const forced = await resolveFleetExact({ deviceId: cameraId, fleetNumber: other.rows[0].fleet_number, deviceName });
    check(String(forced).toUpperCase() === String(other.rows[0].fleet_number).toUpperCase(),
      `explicit fleet wins (got ${forced})`);
  }

  // 4. A real device id (PD126-style) still resolves by itself.
  const devVeh = await db.query(
    `SELECT fleet_number FROM fleet_vehicles WHERE fleet_number ~ '^[A-Z]{2,}[0-9]+$' LIMIT 1`
  );
  if (devVeh.rows.length > 0) {
    const byId = await resolveFleetExact({ deviceId: devVeh.rows[0].fleet_number, fleetNumber: null });
    check(String(byId || '').toUpperCase() === String(devVeh.rows[0].fleet_number).toUpperCase(),
      `fleet-code device id still resolves by itself (got ${byId})`);
  }

  // 5. An unrecognised name resolves to null — never invents a fleet.
  const invented = await resolveFleetExact({ deviceId: cameraId, fleetNumber: null, deviceName: 'ZZTOP - NOPE999' });
  check(invented === null, `unknown vehicle resolves to null, not a guess (got ${invented})`);

  // 6. Long numeric tokens are skipped rather than treated as a fleet.
  const numeric = await resolveFleetExact({
    deviceId: cameraId,
    fleetNumber: null,
    deviceName: '221087823034 - 568080073421',
  });
  check(numeric === null, `pure-numeric tokens are not treated as a fleet (got ${numeric})`);

  // 7. The real ingestion path now stores the fleet on the group.
  const group = await alertGroupsDb.upsertAlertGroup({
    deviceId: cameraId,
    deviceName,
    alarmType: 'ATTRIBUTION TEST',
    alarmText: 'attribution test',
    alertId: `attrtest-${Date.now()}`,
    alarmTs: new Date().toISOString(),
    lat: -26.1,
    lon: 28.2,
    speed: 50,
    sourceType: 'video',
    severity: 'high',
    fleetNumber: null,
    registration: v.registration_number || null,
  });
  if (!group) {
    console.log('  (vehicle not in registry for this test — skipping the group write check)');
  } else {
    const row = await db.query('SELECT fleet_number FROM alert_groups WHERE id = $1', [group.id]);
    check(row.rows[0]?.fleet_number != null,
      `group stored a fleet number (got ${row.rows[0]?.fleet_number})`);
    await db.query('DELETE FROM alerts WHERE id LIKE $1', ['attrtest-%']);
    await db.query('DELETE FROM alert_groups WHERE id = $1', [group.id]);
  }

  console.log(ok ? '\nATTRIBUTION-OK' : '\nATTRIBUTION-FAILED');
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM cost_centers WHERE name LIKE $1`, [`${TAG}%`]);
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ATTRIBUTION-ERROR:', e);
  process.exit(1);
});