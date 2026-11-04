'use strict';
// Local-only: identity canonicalization + Model A authorization + speeding
// alert field storage. Run with a disposable local DATABASE_URL.
const { db, resetSchema, seedBase } = require('./setup');
const identity = require('../src/vehicles/identity');
const authz = require('../src/alerts/authorization');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

(async () => {
  await resetSchema();
  await seedBase();

  console.log('[identity]');
  const resolved = await identity.resolveVehicle({ deviceId: 'b651' });
  check('resolves Geotab id to fleet', resolved?.fleetNumber === 'EX55', JSON.stringify(resolved));
  check('keeps Geotab id separately', resolved?.geotabDeviceId === 'b651');
  check('keeps camera id separately', resolved?.mettaxDeviceId === 'CAM123');
  check('resolves cost centre', resolved?.costCenterId === 5);

  console.log('[authorization Model A]');
  check('allowed for its CC', await authz.canRaiseAlert({ costCenterId: 5, name: 'Heavy Duty Max Speeding 85km/h' }) === true);
  check('denied for another CC', await authz.canRaiseAlert({ costCenterId: 6, name: 'Heavy Duty Max Speeding 85km/h' }) === false);
  check('allowed for global (is_global=true)', await authz.canRaiseAlert({ costCenterId: null, name: 'Heavy Duty Max Speeding 85km/h' }) === true);

  console.log('[group storage]');
  const group = await db.upsertAlertGroup({
    deviceId: 'b651',
    deviceName: 'EX55 - LDR065MP',
    alarmType: 'Heavy Duty Max Speeding 85km/h',
    alarmText: 'Speed 86 km/h exceeded 85 km/h',
    alertId: 'dst-b651-85-1',
    alarmTs: new Date().toISOString(),
    lat: -26.1,
    lon: 28.1,
    speed: 86,
    sourceType: 'telematics',
    severity: 'high',
    fleetNumber: 'EX55',
    registration: 'LDR065MP',
    distanceKm: 1.234,
    durationSeconds: 121.5,
  });
  check('group created', !!group?.id);
  const stored = (await db.query(
    'SELECT device_id, source_device_id, geotab_device_id, mettax_device_id, speed, distance_km, duration_seconds, fleet_number FROM alert_groups WHERE id = $1',
    [group.id]
  )).rows[0];
  check('group device_id is fleet_number', stored?.device_id === 'EX55', JSON.stringify(stored));
  check('source id preserved', stored?.source_device_id === 'b651', JSON.stringify(stored));
  check('geotab id preserved', stored?.geotab_device_id === 'b651', JSON.stringify(stored));
  check('camera id preserved', stored?.mettax_device_id === 'CAM123', JSON.stringify(stored));
  check('flag speed stored', Number(stored?.speed) === 86, JSON.stringify(stored));
  check('flag distance stored', Number(stored?.distance_km) === 1.234, JSON.stringify(stored));
  check('flag duration stored', Number(stored?.duration_seconds) === 121.5, JSON.stringify(stored));
  const member = (await db.query(
    'SELECT device_id, source_device_id, speed, distance_km, duration_seconds FROM alerts WHERE id = $1',
    ['dst-b651-85-1']
  )).rows[0];
  check('member uses fleet id', member?.device_id === 'EX55', JSON.stringify(member));
  check('member keeps speed/distance', Number(member?.speed) === 86 && Number(member?.distance_km) === 1.234, JSON.stringify(member));
  check('member keeps duration', Number(member?.duration_seconds) === 121.5, JSON.stringify(member));

  console.log('[group current values]');
  const group2 = await db.upsertAlertGroup({
    deviceId: 'b651',
    deviceName: 'EX55 - LDR065MP',
    alarmType: 'Heavy Duty Max Speeding 85km/h',
    alarmText: 'Speed 88 km/h exceeded 85 km/h',
    alertId: 'dst-b651-85-2',
    alarmTs: new Date(Date.now() + 1000).toISOString(),
    lat: -26.2,
    lon: 28.2,
    speed: 88,
    sourceType: 'telematics',
    severity: 'high',
    fleetNumber: 'EX55',
    registration: 'LDR065MP',
    distanceKm: 2.5,
    durationSeconds: 125,
  });
  check('same group reused', group2?.id === group?.id, JSON.stringify({ first: group?.id, second: group2?.id }));
  const current = (await db.query(
    'SELECT speed, distance_km, duration_seconds, count FROM alert_groups WHERE id = $1',
    [group.id]
  )).rows[0];
  check('group stores latest speed', Number(current?.speed) === 88, JSON.stringify(current));
  check('group stores latest distance', Number(current?.distance_km) === 2.5, JSON.stringify(current));
  check('group stores latest duration', Number(current?.duration_seconds) === 125, JSON.stringify(current));
  check('group count increments', Number(current?.count) === 2, JSON.stringify(current));
  const firstMember = (await db.query(
    'SELECT speed, distance_km, duration_seconds FROM alerts WHERE id = $1',
    ['dst-b651-85-1']
  )).rows[0];
  check('first member stays immutable', Number(firstMember?.speed) === 86 && Number(firstMember?.distance_km) === 1.234 && Number(firstMember?.duration_seconds) === 121.5, JSON.stringify(firstMember));

  console.log('[denied source cannot create an alert]');
  const denied = await db.upsertAlertGroup({
    deviceId: 'b651',
    deviceName: 'EX55 - LDR065MP',
    alarmType: 'Heavy Duty Max Speeding 90KM/H',
    alertId: 'dst-b651-90-1',
    alarmTs: new Date().toISOString(),
    speed: 92,
    sourceType: 'telematics',
  });
  check('unknown definition is suppressed', denied === null, JSON.stringify(denied));

  console.log(`identity-auth: ${pass} passed, ${fail} failed`);
  await db.closePool();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
