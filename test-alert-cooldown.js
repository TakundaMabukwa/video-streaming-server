'use strict';
// Local-only E2E for the alert cooldown feature: set/cancel semantics, all
// group-creation gates, backup mirrors, open-group bumps, expiry, and the
// poller's memory-consuming suppression.
//
// Run:  docker compose cp test-alert-cooldown.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-alert-cooldown.js

const { query } = require('./src/db/pool');
const db = require('./src/db');
const cooldowns = require('./src/services/alertCooldowns');
const poller = require('./src/services/deviceStatusPoller');

const DEVICE_ID = 'TESTCD01';
const FLEET = 'LH29';          // registered, no mettax id, no driver_scoring cc
const REG = 'LDG368MP';
const DEVICE_NAME = `${FLEET} - ${REG}`;
const COOLED_TYPE = 'Cellphone Use';
const SPEED90_CODE = 'aLv1Bv53LBkClq5rSQ5QPkQ';
const SPEED90_TYPE = 'Speeding 90km/h'; // local alert_definitions name

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}
const groupCount = async (alarmType) => {
  const r = await query('SELECT count(*)::int n FROM alert_groups WHERE device_id = $1 AND alarm_type = $2', [DEVICE_ID, alarmType]);
  return r.rows[0].n;
};
const backupGroup = async (alarmType) => {
  const r = await query('SELECT id, count FROM alert_cooldown_groups WHERE device_id = $1 AND alarm_type = $2', [DEVICE_ID, alarmType]);
  return r.rows[0] || null;
};
const backupMemberCount = async () =>
  (await query('SELECT count(*)::int n FROM alert_cooldown_members WHERE device_id = $1', [DEVICE_ID])).rows[0].n;

async function upsert(alarmType, alertId) {
  return db.upsertAlertGroup({
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    alarmType,
    alarmText: `${alarmType} (cooldown test)`,
    alertId,
    alarmTs: new Date().toISOString(),
    lat: -28.9, lon: 26.4, speed: 60,
    sourceType: 'video',
    severity: 'high',
    fleetNumber: FLEET,
    registration: REG,
  });
}

(async () => {
  console.log('== prep: clean test device ==');
  for (const sql of [
    'DELETE FROM alert_cooldown_members WHERE device_id = $1',
    'DELETE FROM alert_cooldown_groups WHERE device_id = $1',
    'DELETE FROM alert_cooldowns WHERE device_id = $1',
    'DELETE FROM alerts WHERE device_id = $1',
    'DELETE FROM alert_groups WHERE device_id = $1',
    'DELETE FROM telematics_events WHERE device_id = $1',
    'DELETE FROM driving_sessions WHERE device_id = $1',
    'DELETE FROM vehicle_status WHERE device_id = $1',
  ]) await query(sql, [DEVICE_ID]).catch(() => {});
  await query(
    `INSERT INTO geotab_devices (id, name, fleet_number, license_plate)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, fleet_number = EXCLUDED.fleet_number, license_plate = EXCLUDED.license_plate`,
    [DEVICE_ID, DEVICE_NAME, FLEET, REG]
  );

  console.log('== [1] setCooldown semantics ==');
  let cd = await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: COOLED_TYPE, minutes: 60, groupId: null, by: 'tester@srs.local' });
  check('60 minutes stored', cd.ok && cd.minutes === 60 && cd.until != null, JSON.stringify(cd));
  const active = await cooldowns.getActiveCooldown(DEVICE_ID, COOLED_TYPE);
  check('active lookup finds it (case-insensitive type)', !!active && active.cooldown_minutes === 60, JSON.stringify(active));
  check('lookup is scoped: other type → null', (await cooldowns.getActiveCooldown(DEVICE_ID, 'Harsh Braking')) === null);
  cd = await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: COOLED_TYPE, minutes: 1000 });
  check('1000 clamps to 720 (12h max)', cd.minutes === 720, JSON.stringify(cd));
  await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: COOLED_TYPE, minutes: 60 });

  console.log('== [2] upsertAlertGroup gate (video/single path) ==');
  let r = await upsert(COOLED_TYPE, 'cd-1');
  check('cooldown active → returns null (no group)', r === null, JSON.stringify(r));
  check('no alert_groups row created', (await groupCount(COOLED_TYPE)) === 0);
  let bg = await backupGroup(COOLED_TYPE);
  check('backup group row created with count=1', !!bg && Number(bg.count) === 1, JSON.stringify(bg));
  check('backup member row stored (cd-1)', (await backupMemberCount()) === 1, await backupMemberCount());

  r = await upsert(COOLED_TYPE, 'cd-2');
  check('second occurrence still suppressed', r === null);
  bg = await backupGroup(COOLED_TYPE);
  check('backup aggregates count=2 (group semantics)', !!bg && Number(bg.count) === 2, JSON.stringify(bg));
  check('both members stored', (await backupMemberCount()) === 2, await backupMemberCount());
  check('board still has zero groups for the cooled type', (await groupCount(COOLED_TYPE)) === 0);

  console.log('== [3] uncooled type on the same vehicle is untouched ==');
  r = await upsert('Harsh Braking', 'cd-3');
  check('no cooldown → group created normally', !!(r && r.id), JSON.stringify(r));
  check('alert_groups has the Harsh Braking group', (await groupCount('Harsh Braking')) === 1);

  console.log('== [4] open group keeps bumping during a cooldown ==');
  cd = await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: 'Harsh Braking', minutes: 60 });
  check('cooldown now set for the OPEN type too', !!(await cooldowns.getActiveCooldown(DEVICE_ID, 'Harsh Braking')));
  r = await upsert('Harsh Braking', 'cd-4');
  check('open group bumped (not diverted)', !!(r && Number(r.count) === 2), JSON.stringify(r));
  check('no backup row for the open type', (await backupGroup('Harsh Braking')) === null);
  await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: 'Harsh Braking', minutes: 0 });
  check('0 cancels the timer', (await cooldowns.getActiveCooldown(DEVICE_ID, 'Harsh Braking')) === null);

  console.log('== [5] expiry → creation resumes ==');
  await query("UPDATE alert_cooldowns SET cooldown_until = NOW() - INTERVAL '1 second' WHERE device_id = $1 AND lower(alarm_type) = lower($2)", [DEVICE_ID, COOLED_TYPE]);
  check('expired timer no longer active', (await cooldowns.getActiveCooldown(DEVICE_ID, COOLED_TYPE)) === null);
  r = await upsert(COOLED_TYPE, 'cd-5');
  check('after expiry a REAL group is created', !!(r && r.id), JSON.stringify(r));
  check('backup count unchanged by the real create', Number((await backupGroup(COOLED_TYPE)).count) === 2);
  await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: COOLED_TYPE, minutes: 0 });

  console.log('== [6] poller emit gate (fatigue/speed/zone path) ==');
  cd = await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: SPEED90_TYPE, minutes: 60 });
  const emitted = await poller.emitDeviceStatusAlert({
    deviceId: DEVICE_ID, fleetNumber: FLEET, licensePlate: REG,
    signalCode: SPEED90_CODE, alarmText: 'Speed 95 km/h exceeded 90 km/h',
    lat: -28.9, lon: 26.4, speed: 95, ts: new Date().toISOString(),
    extra: { speed: 95 },
  });
  check('emit returns truthy suppressed marker (memory consumed)', !!(emitted && emitted.cooldown_suppressed), JSON.stringify(emitted));
  check('no board group for the cooled speed type', (await groupCount(SPEED90_TYPE)) === 0);
  const speedBackup = await backupGroup(SPEED90_TYPE);
  check('occurrence stored in backup', !!speedBackup && Number(speedBackup.count) === 1, JSON.stringify(speedBackup));

  await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: SPEED90_TYPE, minutes: 0 });
  const emitted2 = await poller.emitDeviceStatusAlert({
    deviceId: DEVICE_ID, fleetNumber: FLEET, licensePlate: REG,
    signalCode: SPEED90_CODE, alarmText: 'Speed 95 km/h exceeded 90 km/h',
    lat: -28.9, lon: 26.4, speed: 95, ts: new Date().toISOString(),
    extra: { speed: 95 },
  });
  check('after cancel the emit creates a real group', !!(emitted2 && emitted2.id), JSON.stringify(emitted2));
  check('board now has the speed group', (await groupCount(SPEED90_TYPE)) === 1);

  console.log('== [7] batch path (camera/video sync) ==');
  cd = await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: 'Seatbelt Violation', minutes: 30 });
  const batchRows = await db.batchUpsertAlertGroups([
    { deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Seatbelt Violation', alarmText: 'belt', alertId: 'cd-b1', alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 40, severity: 'high', sourceType: 'video' },
    { deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Distracted Driving', alarmText: 'phone', alertId: 'cd-b2', alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 40, severity: 'high', sourceType: 'video' },
  ]);
  const batchTypes = (batchRows || []).map((x) => x.alarm_type);
  check('cooled batch entry excluded from results', !batchTypes.includes('Seatbelt Violation'), JSON.stringify(batchTypes));
  check('uncooled batch entry created', batchTypes.includes('Distracted Driving'), JSON.stringify(batchTypes));
  check('cooled entry landed in backup', !!(await backupGroup('Seatbelt Violation')));
  check('batch cooled type has no board group', (await groupCount('Seatbelt Violation')) === 0);
  await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: 'Seatbelt Violation', minutes: 0 });

  console.log('== [7b] sync camera partition (cooled record → backup only, no alerts row) ==');
  const syncService = require('./src/services/syncService');
  cd = await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: 'Bang', minutes: 45 });
  const syncFresh = await syncService.partitionCooledRecords([
    { id: 'cd-s1', deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Bang', alarmText: 'bang', alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 10, severity: 'high' },
    { id: 'cd-s2', deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Distracted Driving', alarmText: 'phone-2', alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 10, severity: 'high' },
  ]);
  check('cooled record removed from the fresh set', syncFresh.length === 1 && syncFresh[0].id === 'cd-s2', JSON.stringify(syncFresh.map((x) => x.id)));
  check('no alerts detection row for the cooled record', (await query("SELECT count(*)::int n FROM alerts WHERE id = 'cd-s1'")).rows[0].n === 0);
  const bgBang = await backupGroup('Bang');
  check('backup group created for the cooled camera record', !!bgBang && Number(bgBang.count) === 1, JSON.stringify(bgBang));
  check('backup member row stored (cd-s1)', (await query("SELECT count(*)::int n FROM alert_cooldown_members WHERE id = 'cd-s1'")).rows[0].n === 1);
  check('no board group for the cooled camera record', (await groupCount('Bang')) === 0);
  await cooldowns.setCooldown({ deviceId: DEVICE_ID, alarmType: 'Bang', minutes: 0 });
  const syncFresh2 = await syncService.partitionCooledRecords([
    { id: 'cd-s3', deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Bang', alarmText: 'bang', alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 10, severity: 'high' },
  ]);
  check('after cancel the same record passes through as fresh', syncFresh2.length === 1 && syncFresh2[0].id === 'cd-s3');
  // Cancel DELETEs the alert_cooldowns row; backup rows cascade away with it
  // (ON DELETE CASCADE, by design — cancel = forget this cooldown entirely).
  check('cancel removed the backup group via cascade', (await backupGroup('Bang')) === null);

  console.log('== [8] no-cooldown baseline (feature absent = today) ==');
  const before = (await query('SELECT count(*)::int n FROM alert_cooldowns')).rows[0].n;
  r = await upsert('Reckless Driving', 'cd-6');
  check('without a cooldown row the path is unchanged (group created)', !!(r && r.id));
  const after = (await query('SELECT count(*)::int n FROM alert_cooldowns')).rows[0].n;
  check('creation does not touch alert_cooldowns', before === after);

  console.log('');
  console.log('groups for test device:', JSON.stringify((await query('SELECT alarm_type, count FROM alert_groups WHERE device_id = $1', [DEVICE_ID])).rows));
  console.log('backup groups:', JSON.stringify((await query('SELECT alarm_type, count FROM alert_cooldown_groups WHERE device_id = $1', [DEVICE_ID])).rows));

  console.log('== cleanup ==');
  for (const sql of [
    'DELETE FROM alert_cooldown_members WHERE device_id = $1',
    'DELETE FROM alert_cooldown_groups WHERE device_id = $1',
    'DELETE FROM alert_cooldowns WHERE device_id = $1',
    'DELETE FROM alerts WHERE device_id = $1',
    'DELETE FROM alert_groups WHERE device_id = $1',
    'DELETE FROM telematics_events WHERE device_id = $1',
    'DELETE FROM driving_sessions WHERE device_id = $1',
    'DELETE FROM vehicle_status WHERE device_id = $1',
    'DELETE FROM geotab_devices WHERE id = $1',
  ]) await query(sql, [DEVICE_ID]).catch(() => {});

  console.log(`alert-cooldown: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
