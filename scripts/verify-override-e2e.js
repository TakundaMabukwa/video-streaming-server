// E2E: vehicle alert overrides through the REAL poller emit path.
//  - overridden vehicle  -> no group, no event, no alert row
//  - control vehicle     -> group + event + alert row created
process.env.DATABASE_URL = 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';
const db = require('../src/db');
const overrides = require('../src/services/vehicleAlertOverrides');
const { emitDeviceStatusAlert } = require('../src/services/deviceStatusPoller');

const SPEED_85 = 'aURw7fNBdxEGWY3NXil_yIg';
const OVR_FLEET = 'QAE2EOVR';
const PLAIN_FLEET = 'QAE2EPLN';

async function countRows(fleet) {
  const g = await db.query('SELECT count(*)::int c FROM alert_groups WHERE fleet_number = $1', [fleet]);
  const a = await db.query('SELECT count(*)::int c FROM alerts WHERE device_id = $1', [fleet]);
  const e = await db.query('SELECT count(*)::int c FROM telematics_events WHERE fleet_number = $1', [fleet]);
  return { groups: g.rows[0].c, alerts: a.rows[0].c, events: e.rows[0].c };
}

(async () => {
  await db.initializeDatabase();
  let ok = true;
  const fail = (m) => { ok = false; console.log('FAIL ' + m); };
  const pass = (m) => console.log('PASS ' + m);

  // 1) Register both test vehicles in the EPS registry (fleet guard).
  await db.query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center)
     VALUES ($1, $2, 'Test', 'Test', 'QA'), ($3, $4, 'Test', 'Test', 'QA')
     ON CONFLICT (fleet_number, registration_number) DO NOTHING`,
    [OVR_FLEET, 'QAE2EOVRX', PLAIN_FLEET, 'QAE2EPLNX']
  );

  // 2) Override: the OVR vehicle must not raise speeding 85.
  await db.query(
    `INSERT INTO vehicle_alert_overrides (fleet_number, alert_types, signal_codes, created_by, notes)
     VALUES ($1, ARRAY['Speeding 85km/h'], ARRAY[$2], 'qa', 'e2e')
     ON CONFLICT (COALESCE(fleet_number,''), COALESCE(registration,''))
     DO UPDATE SET alert_types = EXCLUDED.alert_types, signal_codes = EXCLUDED.signal_codes`,
    [OVR_FLEET, SPEED_85]
  );
  await overrides.invalidate();
  console.log(`override active for ${OVR_FLEET} (speed 85)`);

  // 3) Fire the REAL poller emit for the overridden vehicle.
  const r1 = await emitDeviceStatusAlert({
    deviceId: OVR_FLEET, fleetNumber: OVR_FLEET, licensePlate: 'QAE2EOVRX',
    signalCode: SPEED_85, alarmText: 'Speed 88 km/h exceeded 85 km/h',
    lat: -33.9, lon: 25.6, speed: 88, ts: new Date().toISOString(),
  });
  const c1 = await countRows(OVR_FLEET);
  if (r1) fail(`overridden vehicle still created a group (id=${r1.id})`);
  else pass('overridden vehicle: emit returned null (no group)');
  if (c1.groups || c1.alerts || c1.events) fail(`overridden vehicle wrote rows ${JSON.stringify(c1)}`);
  else pass(`overridden vehicle: no rows anywhere ${JSON.stringify(c1)}`);

  // 4) Control vehicle: same alert, no override -> must create everything.
  const r2 = await emitDeviceStatusAlert({
    deviceId: PLAIN_FLEET, fleetNumber: PLAIN_FLEET, licensePlate: 'QAE2EPLNX',
    signalCode: SPEED_85, alarmText: 'Speed 88 km/h exceeded 85 km/h',
    lat: -33.9, lon: 25.6, speed: 88, ts: new Date().toISOString(),
  });
  const c2 = await countRows(PLAIN_FLEET);
  if (!r2 || !r2.id) fail('control vehicle did NOT create a group');
  else pass(`control vehicle: group created (id=${r2.id})`);
  if (!c2.groups) fail('control vehicle: no alert_groups row');
  else pass(`control vehicle: alert_groups=${c2.groups} alerts=${c2.alerts} events=${c2.events}`);
  if (!c2.events) fail('control vehicle: no telematics_events row');
  else pass('control vehicle: telematics_events archived');
  if (!c2.alerts) fail('control vehicle: no alerts member row');
  else pass('control vehicle: alerts member row linked');

  // 5) The control vehicle now has an override -> its NEXT detection is blocked.
  await db.query(
    `INSERT INTO vehicle_alert_overrides (fleet_number, alert_types, signal_codes, created_by)
     VALUES ($1, ARRAY['Speeding 85km/h'], ARRAY[$2], 'qa')
     ON CONFLICT (COALESCE(fleet_number,''), COALESCE(registration,''))
     DO UPDATE SET alert_types = EXCLUDED.alert_types`,
    [PLAIN_FLEET, SPEED_85]
  );
  await overrides.invalidate();
  const before = await countRows(PLAIN_FLEET);
  const r3 = await emitDeviceStatusAlert({
    deviceId: PLAIN_FLEET, fleetNumber: PLAIN_FLEET, licensePlate: 'QAE2EPLNX',
    signalCode: SPEED_85, alarmText: 'Speed 91 km/h exceeded 85 km/h',
    lat: -33.9, lon: 25.6, speed: 91, ts: new Date().toISOString(),
  });
  const after = await countRows(PLAIN_FLEET);
  if (r3) fail('second detection still created a group after the override was added');
  else pass('second detection blocked once the override was added');
  if (after.groups !== before.groups) fail(`group count changed ${before.groups} -> ${after.groups}`);
  else pass(`counts unchanged after suppression ${JSON.stringify(after)}`);

  // 6) A DIFFERENT alert type for the overridden vehicle still fires.
  const OTHER = 'aXmPcWqFx3kKp1XKdQDQEYQ'; // 8 Hour Duration Check
  const r4 = await emitDeviceStatusAlert({
    deviceId: OVR_FLEET, fleetNumber: OVR_FLEET, licensePlate: 'QAE2EOVRX',
    signalCode: OTHER, alarmText: '8 hour duration',
    lat: -33.9, lon: 25.6, speed: 40, ts: new Date().toISOString(),
  });
  if (r4 && r4.id) pass('other alert type still fires for the overridden vehicle');
  else fail('other alert type was wrongly suppressed');

  // Cleanup
  await db.query('DELETE FROM vehicle_alert_overrides WHERE fleet_number IN ($1,$2)', [OVR_FLEET, PLAIN_FLEET]);
  await db.query('DELETE FROM alerts WHERE device_id IN ($1,$2)', [OVR_FLEET, PLAIN_FLEET]);
  await db.query('DELETE FROM alert_groups WHERE fleet_number IN ($1,$2)', [OVR_FLEET, PLAIN_FLEET]);
  await db.query('DELETE FROM telematics_events WHERE fleet_number IN ($1,$2)', [OVR_FLEET, PLAIN_FLEET]);
  await db.query('DELETE FROM fleet_vehicles WHERE fleet_number IN ($1,$2)', [OVR_FLEET, PLAIN_FLEET]);
  await overrides.invalidate();

  console.log(ok ? 'OVERRIDE-E2E-OK' : 'OVERRIDE-E2E-FAIL');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('VERIFY-FAIL', e.message); process.exit(1); });
