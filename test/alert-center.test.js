'use strict';
// Local-only: alert center read endpoints + strict resolve.
const { db, resetSchema, seedBase } = require('./setup');
const controller = require('../src/controllers/alertCenterController');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`); }
}

function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(n) { this.statusCode = n; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    handler(req, res);
  });
}

(async () => {
  await resetSchema();
  await seedBase();

  const group = await db.query(
    `INSERT INTO alert_groups
      (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id,
       last_alert_ts, lat, lon, speed, distance_km, duration_seconds, source_type,
       severity, fleet_number, notes)
     VALUES
      ('ex55:approaching zone', 'EX55', 'EX55 - LDR065MP', 'Approaching Zone',
       'Approaching High Risk Zone', 2, 'member-1', NOW(), -26.1, 28.1, 72, 0.45,
       120, 'telematics', 'medium', 'EX55', 'group note')
     RETURNING id`
  );
  const groupId = Number(group.rows[0].id);

  await db.query(
    `INSERT INTO alerts
      (id, device_id, device_name, alarm_type, alarm_text, alarm_ts, lat, lon, speed,
       distance_km, duration_seconds, severity, fleet_number, source_type, notes, alert_group_id)
     VALUES
      ('member-1', 'EX55', 'EX55 - LDR065MP', 'Approaching Zone', 'Approaching High Risk Zone',
       NOW(), -26.1, 28.1, 72, 0.45, 120, 'medium', 'EX55', 'telematics', 'member note', $1),
      ('member-2', 'EX55', 'EX55 - LDR065MP', 'Approaching Zone', 'Approaching High Risk Zone',
       NOW() - INTERVAL '1 minute', -26.11, 28.11, 60, 0.2, 60, 'medium', 'EX55', 'telematics', NULL, $1)`,
    [groupId]
  );

  const second = await db.query(
    `INSERT INTO alert_groups
      (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id,
       last_alert_ts, lat, lon, speed, distance_km, duration_seconds, source_type,
       severity, fleet_number)
     VALUES
      ('ex55:fatigue', 'EX55', 'EX55 - LDR065MP', 'Driver Fatigue 3h', 'Fatigue',
       1, 'member-3', NOW() - INTERVAL '2 minutes', -26.2, 28.2, 40, 0.1, 300,
       'telematics', 'high', 'EX55')
     RETURNING id`
  );
  const secondId = Number(second.rows[0].id);

  console.log('[batch alert timestamps]');
  await db.batchUpsertAlerts([{
    id: 'batch-ts-test', deviceId: 'EX55', deviceName: 'EX55 - LDR065MP', alarmType: 'Overtime Driving',
    alarmTs: new Date('2026-11-04T19:17:25Z'), alarmTsEnd: new Date('2026-11-04T19:17:31Z'),
    lat: -26.1, lon: 28.1, speed: 10, severity: 'low', fleetNumber: 'EX55',
  }]);
  const batchRow = (await db.query("SELECT alarm_ts, alarm_ts_end FROM alerts WHERE id='batch-ts-test'")).rows[0];
  check('batch alarm_ts stored as timestamp', !!batchRow && new Date(batchRow.alarm_ts).toISOString() === '2026-11-04T19:17:25.000Z', JSON.stringify(batchRow));
  check('batch alarm_ts_end stored as timestamp', !!batchRow && new Date(batchRow.alarm_ts_end).toISOString() === '2026-11-04T19:17:31.000Z', JSON.stringify(batchRow));

  console.log('[group detail]');
  const detail = await call(controller.getAlertGroupDetail, { params: { id: String(groupId) } });
  check('detail 200', detail.status === 200, detail);
  check('id is group id', detail.body?.alert?.id === String(groupId), detail.body?.alert?.id);
  check('alert_id is latest member id', detail.body?.alert?.alert_id === 'member-1');
  check('speed from group', Number(detail.body?.alert?.speed) === 72);
  check('distance from group', Number(detail.body?.alert?.distance) === 0.45);
  check('duration from group', Number(detail.body?.alert?.duration_seconds) === 120);
  check('last occurrence present', !!detail.body?.alert?.last_occurrence);
  check('notes present', detail.body?.alert?.notes === 'group note');

  console.log('[open by fleet]');
  const open = await call(controller.getOpenAlertsByFleet, { query: { fleet_number: 'ex55' } });
  check('open 200', open.status === 200, open);
  check('returns both severities', open.body?.count === 2, open.body?.count);
  check('ids are group ids', open.body?.alerts?.every((a) => /^[0-9]+$/.test(a.id)), JSON.stringify(open.body?.alerts?.map((a) => a.id)));

  console.log('[members]');
  const members = await call(controller.getAlertGroupMembers, { params: { id: String(groupId) }, query: { limit: '10' } });
  check('members 200', members.status === 200, members);
  check('all linked members', members.body?.count === 2, members.body?.count);
  check('group count returned', members.body?.group_count === 2, members.body?.group_count);
  check('linked count returned', members.body?.linked_count === 2, members.body?.linked_count);
  check('member carries metrics', Number(members.body?.members?.[0]?.distance) === 0.45 && Number(members.body?.members?.[0]?.duration_seconds) === 120);
  check('member carries own notes', members.body?.members?.some((m) => m.notes === 'member note'));

  console.log('[occurrence]');
  const occurrence = await call(controller.getAlertOccurrenceDetail, { params: { id: 'member-1' } });
  check('occurrence 200', occurrence.status === 200, occurrence);
  check('occurrence group id', Number(occurrence.body?.alert?.group_id) === groupId);
  check('occurrence requires notes intact', occurrence.body?.alert?.notes === 'member note');

  console.log('[resolve validation]');
  const missing = await call(controller.resolveAlerts, {
    body: { items: [{ id: groupId, notes: '' }, { id: secondId, notes: 'ok' }] },
    user: { email: 'tester@example.com' },
  });
  check('missing note 400', missing.status === 400, missing);
  const stillOpen = await db.query('SELECT count(*)::int n FROM alert_groups WHERE id = ANY($1::int[]) AND resolved = FALSE', [[groupId, secondId]]);
  check('nothing updated on validation failure', stillOpen.rows[0].n === 2, stillOpen.rows[0].n);

  console.log('[resolve success]');
  const resolved = await call(controller.resolveAlerts, {
    body: {
      items: [
        { id: groupId, notes: 'confirmed' },
        { id: secondId, notes: 'duplicate' },
      ],
      cooldownMinutes: 30,
    },
    user: { email: 'tester@example.com' },
  });
  check('resolve 200', resolved.status === 200, resolved);
  check('two groups resolved', resolved.body?.resolved === 2, resolved.body);
  const rows = await db.query('SELECT id, resolved, false_alert, notes FROM alert_groups WHERE id = ANY($1::int[]) ORDER BY id', [[groupId, secondId]]);
  check('stored per-group notes', rows.rows.find((r) => Number(r.id) === groupId)?.notes === 'confirmed' && rows.rows.find((r) => Number(r.id) === secondId)?.notes === 'duplicate', JSON.stringify(rows.rows));
  const memberRows = await db.query('SELECT count(*)::int n FROM alerts WHERE alert_group_id = $1 AND resolved = TRUE AND false_alert = FALSE', [groupId]);
  check('members cascade resolved', memberRows.rows[0].n === 2, memberRows.rows[0].n);
  const cooldown = await db.query('SELECT count(*)::int n FROM alert_cooldowns WHERE device_id = $1 AND cooldown_until > NOW()', ['EX55']);
  check('cooldown rows created', cooldown.rows[0].n === 2, cooldown.rows[0].n);

  console.log('[open excludes closed]');
  const after = await call(controller.getOpenAlertsByFleet, { query: { fleet_number: 'EX55' } });
  check('closed groups disappear from fleet open', after.body?.count === 0, after.body?.count);
  check('closed-since-midnight count returned', after.body?.closed_since_midnight === 2, after.body?.closed_since_midnight);
  const byType = await db.getClosedAlertGroupCountsByTypeSinceMidnight('EX55');
  check('per-type closed counts separate types', Number(byType.get('approaching zone') || 0) === 1 && Number(byType.get('driver fatigue 3h') || 0) === 1, JSON.stringify([...byType.entries()]));

  console.log(`alert-center: ${pass} passed, ${fail} failed`);
  await db.closePool();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
