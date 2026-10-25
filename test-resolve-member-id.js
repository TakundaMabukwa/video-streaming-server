'use strict';
// Local-only test for the Phase C resolve path: member-id fallback
// (alerts.id / group_key → group), background deduction flag, and the
// [RESOLVE] timing line. Uses mock req/res against the real controller —
// no HTTP server, no prod contact.
//
// Run:  docker compose cp test-resolve-member-id.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-resolve-member-id.js

const { query } = require('./src/db/pool');
const db = require('./src/db');
const { resolveAlert } = require('./src/controllers/dbAlertController');

const DEVICE_ID = 'TESTRM01';
const FLEET = 'LH29';
const REG = 'LDG368MP';
const DEVICE_NAME = `${FLEET} - ${REG}`;

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

(async () => {
  console.log('== prep ==');
  for (const sql of [
    'DELETE FROM alert_cooldown_members WHERE device_id = $1',
    'DELETE FROM alert_cooldown_groups WHERE device_id = $1',
    'DELETE FROM alert_cooldowns WHERE device_id = $1',
    'DELETE FROM alerts WHERE device_id = $1',
    'DELETE FROM alert_groups WHERE device_id = $1',
  ]) await query(sql, [DEVICE_ID]).catch(() => {});

  const group = await db.upsertAlertGroup({
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    alarmType: 'Cellphone Use',
    alarmText: 'phone use (resolve test)',
    alertId: 'rm-member-1',
    alarmTs: new Date().toISOString(),
    lat: -28.9, lon: 26.4, speed: 60,
    sourceType: 'video',
    severity: 'high',
    fleetNumber: FLEET,
    registration: REG,
  });
  check('fixture group created', !!(group && group.id), JSON.stringify(group));

  console.log('== [1] resolve by member alert id (the freeze case) ==');
  let res = mockRes();
  await resolveAlert(
    { params: { id: 'rm-member-1' }, body: { userId: 'tester@srs.local', notes: 'closed via member id', closureType: 'resolved' }, user: null },
    res,
  );
  check('member-id close returns success', res.body?.success === true && res.body?.groupId === Number(group.id), JSON.stringify(res.body));
  check('group marked resolved in DB', (await query('SELECT resolved FROM alert_groups WHERE id = $1', [group.id])).rows[0]?.resolved === true);

  console.log('== [2] resolve by numeric group id (old contract) ==');
  const g2 = await db.upsertAlertGroup({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Harsh Braking',
    alarmText: 'hb (resolve test)', alertId: 'rm-member-2',
    alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 70,
    sourceType: 'video', severity: 'high', fleetNumber: FLEET, registration: REG,
  });
  res = mockRes();
  await resolveAlert(
    { params: { id: String(g2.id) }, body: { userId: 'tester@srs.local', notes: 'closed via group id', closureType: 'resolved' }, user: null },
    res,
  );
  check('numeric group-id close still works', res.body?.success === true && res.body?.groupId === Number(g2.id), JSON.stringify(res.body));

  console.log('== [3] resolve by group_key ==');
  const g3 = await db.upsertAlertGroup({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Seatbelt Violation',
    alarmText: 'belt (resolve test)', alertId: 'rm-member-3',
    alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 55,
    sourceType: 'video', severity: 'high', fleetNumber: FLEET, registration: REG,
  });
  res = mockRes();
  await resolveAlert(
    { params: { id: String(g3.group_key) }, body: { userId: 'tester@srs.local', notes: 'closed via group key', closureType: 'resolved' }, user: null },
    res,
  );
  check('group_key close resolves the group', res.body?.success === true && res.body?.groupId === Number(g3.id), JSON.stringify(res.body));

  console.log('== [4] unknown id → 404, not a 400 hang ==');
  res = mockRes();
  await resolveAlert(
    { params: { id: 'no-such-alert-xyz' }, body: { userId: 'tester@srs.local', notes: 'should 404', closureType: 'resolved' }, user: null },
    res,
  );
  check('unknown id returns 404', res.statusCode === 404 && res.body?.success === false, JSON.stringify({ code: res.statusCode, body: res.body }));

  console.log('== [5] cooldown contract: absent = no timer action ==');
  const beforeCd = (await query('SELECT count(*)::int n FROM alert_cooldowns WHERE device_id = $1', [DEVICE_ID])).rows[0].n;
  const g4 = await db.upsertAlertGroup({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Distracted Driving',
    alarmText: 'dd (cooldown-absent test)', alertId: 'rm-member-4',
    alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 50,
    sourceType: 'video', severity: 'high', fleetNumber: FLEET, registration: REG,
  });
  res = mockRes();
  await resolveAlert(
    { params: { id: String(g4.id) }, body: { userId: 'tester@srs.local', notes: 'no cooldown field', closureType: 'resolved' }, user: null },
    res,
  );
  const afterCd = (await query('SELECT count(*)::int n FROM alert_cooldowns WHERE device_id = $1', [DEVICE_ID])).rows[0].n;
  check('absent cooldownMinutes leaves alert_cooldowns untouched', res.body?.success === true && beforeCd === afterCd, JSON.stringify({ beforeCd, afterCd, cd: res.body?.cooldown }));

  console.log('== [6] cooldownMinutes > 0 starts a timer ==');
  const g5 = await db.upsertAlertGroup({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Bang',
    alarmText: 'bang (cooldown-set test)', alertId: 'rm-member-5',
    alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 50,
    sourceType: 'video', severity: 'high', fleetNumber: FLEET, registration: REG,
  });
  res = mockRes();
  await resolveAlert(
    { params: { id: String(g5.id) }, body: { userId: 'tester@srs.local', notes: '30 min cooldown', closureType: 'resolved', cooldownMinutes: 30 }, user: null },
    res,
  );
  const cdRow = (await query('SELECT cooldown_minutes FROM alert_cooldowns WHERE device_id = $1 AND lower(alarm_type) = lower($2)', [DEVICE_ID, 'Bang'])).rows[0];
  check('positive cooldownMinutes starts the timer', res.body?.success === true && Number(cdRow?.cooldown_minutes) === 30, JSON.stringify({ cd: res.body?.cooldown, cdRow }));

  console.log('== [7] invalid cooldownMinutes → 400 ==');
  const g6 = await db.upsertAlertGroup({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'OCCLUSION',
    alarmText: 'occ (invalid cooldown test)', alertId: 'rm-member-6',
    alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 50,
    sourceType: 'video', severity: 'low', fleetNumber: FLEET, registration: REG,
  });
  res = mockRes();
  await resolveAlert(
    { params: { id: String(g6.id) }, body: { userId: 'tester@srs.local', notes: 'bad cooldown', closureType: 'resolved', cooldownMinutes: 1000 }, user: null },
    res,
  );
  check('cooldownMinutes > 720 rejected with 400', res.statusCode === 400, res.statusCode);
  check('group NOT closed when cooldown invalid', (await query('SELECT resolved FROM alert_groups WHERE id = $1', [g6.id])).rows[0]?.resolved !== true);

  console.log('== cleanup ==');
  for (const sql of [
    'DELETE FROM alert_cooldown_members WHERE device_id = $1',
    'DELETE FROM alert_cooldown_groups WHERE device_id = $1',
    'DELETE FROM alert_cooldowns WHERE device_id = $1',
    'DELETE FROM alerts WHERE device_id = $1',
    'DELETE FROM alert_groups WHERE device_id = $1',
  ]) await query(sql, [DEVICE_ID]).catch(() => {});

  console.log(`resolve-member-id: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
