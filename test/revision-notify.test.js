'use strict';
// Local-only: verifies alert_groups revision + LISTEN/NOTIFY contract.
// Run with a disposable local DATABASE_URL.
const { Client } = require('pg');
const db = require('../src/db');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

function makeQueue(client) {
  const queue = [];
  const waiters = [];
  client.on('notification', (msg) => {
    let payload = null;
    try { payload = JSON.parse(msg.payload || '{}'); } catch { payload = { raw: msg.payload }; }
    queue.push(payload);
    while (waiters.length > 0) waiters.shift()();
  });
  return async function waitFor(match, timeoutMs = 3000) {
    const started = Date.now();
    for (;;) {
      const idx = queue.findIndex(match);
      if (idx >= 0) return queue.splice(idx, 1)[0];
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for notification');
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };
}

(async () => {
  await db.initializeDatabase();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('LISTEN video_alert_broadcast_channel');
  const waitFor = makeQueue(client);

  const suffix = Date.now().toString(36);
  const groupKey = `test:${suffix}`;

  console.log('[insert open]');
  const inserted = await db.query(
    `INSERT INTO alert_groups
       (group_key, device_id, device_name, alarm_type, alarm_text, count,
        last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
     VALUES ($1, 'EX55', 'EX55 - LDR065MP', 'Heavy Duty Max Speeding 85km/h',
             'Speed 86 km/h exceeded 85 km/h', 1, 'dst-test-1', NOW(),
             -26.1, 28.1, 86, 'telematics', 'high', 'EX55')
     RETURNING id, revision`,
    [groupKey]
  );
  const groupId = inserted.rows[0].id;
  const firstRevision = Number(inserted.rows[0].revision);
  check('insert got a revision', firstRevision > 0, inserted.rows[0].revision);

  const createdEvent = await waitFor((e) => e.type === 'ALERT_DELTA' && String(e.id) === String(groupId));
  check('insert emits ALERT_DELTA', createdEvent.action === 'UPSERT', JSON.stringify(createdEvent));
  check('payload uses fleet_number', createdEvent.fleet_number === 'EX55', JSON.stringify(createdEvent));
  check('payload has card fields', createdEvent.row?.alert_type === 'Heavy Duty Max Speeding 85km/h'
    && createdEvent.row?.repeated_count === 1
    && createdEvent.row?.severity === 'high'
    && createdEvent.row?.speed === 86, JSON.stringify(createdEvent.row));

  console.log('[update open]');
  await db.query(
    `UPDATE alert_groups SET count = count + 1, last_alert_ts = NOW() WHERE id = $1`,
    [groupId]
  );
  const updatedEvent = await waitFor((e) => e.type === 'ALERT_DELTA' && String(e.id) === String(groupId) && e.row?.repeated_count === 2);
  check('update emits ALERT_DELTA', updatedEvent.action === 'UPSERT', JSON.stringify(updatedEvent));
  check('revision increases on update', Number(updatedEvent.revision) > firstRevision,
    `${firstRevision} -> ${updatedEvent.revision}`);

  console.log('[resolve]');
  await db.query(
    `UPDATE alert_groups SET resolved = TRUE, status = 'resolved', resolved_at = NOW(), resolved_by = 'tester' WHERE id = $1`,
    [groupId]
  );
  const closedEvent = await waitFor((e) => e.type === 'ALERT_CLOSED' && String(e.id) === String(groupId));
  check('resolve emits ALERT_CLOSED (not a DB delete)', closedEvent.resolved === true && !closedEvent.purged, JSON.stringify(closedEvent));
  check('closed payload carries actor/time', closedEvent.resolved_by === 'tester' && !!closedEvent.resolved_at, JSON.stringify(closedEvent));
  const rowAfter = (await db.query('SELECT resolved, false_alert, count FROM alert_groups WHERE id = $1', [groupId])).rows[0];
  check('row still exists after resolve', !!rowAfter, JSON.stringify(rowAfter));
  check('resolved row keeps history', rowAfter.resolved === true && rowAfter.false_alert === false, JSON.stringify(rowAfter));

  console.log('[false alert]');
  const second = await db.query(
    `INSERT INTO alert_groups
       (group_key, device_id, device_name, alarm_type, alarm_text, count,
        last_alert_id, last_alert_ts, source_type, severity, fleet_number)
     VALUES ($1, 'EX55', 'EX55 - LDR065MP', 'Harsh Braking', 'Harsh braking',
             1, 'dst-test-2', NOW(), 'telematics', 'medium', 'EX55')
     RETURNING id, revision`,
    [`${groupKey}:false`]
  );
  const secondId = second.rows[0].id;
  await waitFor((e) => e.type === 'ALERT_DELTA' && String(e.id) === String(secondId));
  await db.query(
    `UPDATE alert_groups SET resolved = TRUE, false_alert = TRUE, status = 'resolved', resolved_at = NOW(), resolved_by = 'tester' WHERE id = $1`,
    [secondId]
  );
  const falseEvent = await waitFor((e) => e.type === 'ALERT_CLOSED' && String(e.id) === String(secondId));
  check('false alert emits ALERT_CLOSED with false_alert=true', falseEvent.false_alert === true, JSON.stringify(falseEvent));
  const falseRow = (await db.query('SELECT resolved, false_alert FROM alert_groups WHERE id = $1', [secondId])).rows[0];
  check('false-alert row still exists', !!falseRow && falseRow.resolved === true && falseRow.false_alert === true, JSON.stringify(falseRow));

  console.log('[physical purge]');
  await db.query('DELETE FROM alert_groups WHERE id = $1', [secondId]);
  const purgeEvent = await waitFor((e) => e.type === 'ALERT_CLOSED' && String(e.id) === String(secondId) && e.purged === true);
  check('physical delete is explicit PURGED event', purgeEvent.action === 'PURGED' && purgeEvent.purged === true, JSON.stringify(purgeEvent));

  await client.end();
  await db.closePool();
  console.log(`revision-notify: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  try { await db.closePool(); } catch {}
  process.exit(2);
});
