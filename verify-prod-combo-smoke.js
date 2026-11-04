// Production smoke test for AND-combination alert groups.
// Creates its own tagged definitions + combo, pushes synthetic detections
// through the SAME code path production uses, asserts the merged group, then
// removes every row it created. Safe to run on a live database.
process.env.DATABASE_URL = process.env.DATABASE_URL;

const db = require('./src/db');
const alertCombos = require('./src/services/alertCombos');
const { sweepExpiredCombos } = require('./src/db/combo_groups');

const TAG = 'prodsmoke';
const DEV = `${TAG}-dev`;
let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

async function cleanup() {
  await db.query(`DELETE FROM alert_combo_events WHERE device_id = $1`, [DEV]).catch(() => {});
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}%`]).catch(() => {});
  await db.query(`DELETE FROM alert_groups WHERE device_id = $1`, [DEV]).catch(() => {});
  await db.query(`DELETE FROM alert_group_config_overrides WHERE group_config_id IN (
                   SELECT id FROM alert_group_configs WHERE name = $1)`, [`${TAG} Combo`]).catch(() => {});
  await db.query(`DELETE FROM alert_group_config_members WHERE group_config_id IN (
                   SELECT id FROM alert_group_configs WHERE name = $1)`, [`${TAG} Combo`]).catch(() => {});
  await db.query(`DELETE FROM alert_group_configs WHERE name = $1`, [`${TAG} Combo`]).catch(() => {});
  await db.query(`DELETE FROM alert_definitions WHERE signal_code LIKE $1`, [`${TAG}-%`]).catch(() => {});
}

(async () => {
  await cleanup();

  // Two throwaway definitions + a 5 minute combo.
  const a = (await db.query(
    `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
     VALUES ($1,'telematics','prod smoke',$2,'HIGH') RETURNING id, name`,
    [`${TAG} Alert A`, `${TAG}-SIG-A`]
  )).rows[0];
  const b = (await db.query(
    `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
     VALUES ($1,'telematics','prod smoke',$2,'HIGH') RETURNING id, name`,
    [`${TAG} Alert B`, `${TAG}-SIG-B`]
  )).rows[0];

  const combo = (await db.query(
    `INSERT INTO alert_group_configs (name, severity, combo_enabled, combo_window_seconds)
     VALUES ($1,'CRITICAL',TRUE,300) RETURNING id`, [`${TAG} Combo`]
  )).rows[0];
  await db.query(
    `INSERT INTO alert_group_config_members (group_config_id, alert_definition_id) VALUES ($1,$2),($1,$3)`,
    [combo.id, a.id, b.id]
  );
  alertCombos.invalidate();
  console.log(`setup: combo ${combo.id} (${combo.name}) window=300s members=${a.name} + ${b.name}`);

  // CC-less vehicle -> global scope, exactly like a vehicle with no CC.
  const detect = (id, type, ts) => alertCombos.handleDetection({
    alertId: id, deviceId: DEV, deviceName: `${DEV} - SMOKE`,
    alarmType: type, alarmText: 'prod smoke', alarmTs: ts,
    lat: -26.1, lon: 28.2, speed: 60, severity: 'high',
    fleetNumber: `${TAG}-fleet`, sourceType: 'telematics', costCenterId: null,
  });

  const now = new Date();
  const ago = (s) => new Date(now.getTime() - s * 1000).toISOString();

  // 1. First member alone is held back.
  const first = await detect(`${TAG}-a1`, a.name, ago(120));
  check(first.action === 'staged', `first member held back (got ${first.action})`);
  let groups = await db.query(`SELECT 1 FROM alert_groups WHERE device_id = $1`, [DEV]);
  check(groups.rows.length === 0, 'nothing on the board for the partial');

  // 2. Second member 3 min later -> inside the 5 min window -> merged group.
  const second = await detect(`${TAG}-b1`, b.name, ago(0));
  check(second.action === 'raised', `combo raised on the second member (got ${second.action})`);
  check(second.groupRows.length === 1, 'exactly one merged group');

  const merged = await db.query(
    `SELECT id, alarm_type, severity FROM alert_groups WHERE device_id = $1`, [DEV]
  );
  check(merged.rows.length === 1, `one group row (got ${merged.rows.length})`);
  check(merged.rows[0].alarm_type === `${TAG} Combo`, `named after the combo (got "${merged.rows[0].alarm_type}")`);
  check(String(merged.rows[0].severity).toLowerCase() === 'critical', 'carries the combo severity');

  const members = await db.query(
    `SELECT alarm_type, combo_state FROM alerts WHERE alert_group_id = $1`, [merged.rows[0].id]
  );
  check(members.rows.length === 2, `both members linked (got ${members.rows.length})`);
  check(members.rows.every((m) => m.combo_state === null), 'members released from pending');

  // 3. Members are visible through the same query the timeline uses.
  const timeline = await db.query(
    `SELECT id, alarm_type FROM alerts WHERE alert_group_id = $1 ORDER BY alarm_ts DESC`, [merged.rows[0].id]
  );
  check(timeline.rows.length === 2, 'timeline query returns both members');

  // 4. Out-of-window pair never completes.
  const v2 = `${TAG}-dev2`;
  const detect2 = (id, type, ts) => alertCombos.handleDetection({
    alertId: id, deviceId: v2, deviceName: `${v2} - SMOKE`,
    alarmType: type, alarmText: 'prod smoke', alarmTs: ts,
    lat: -26.1, lon: 28.2, speed: 60, severity: 'high',
    fleetNumber: `${TAG}-fleet`, sourceType: 'telematics', costCenterId: null,
  });
  await detect2(`${TAG}-a2`, a.name, ago(900)); // 15 min ago
  await detect2(`${TAG}-b2`, b.name, ago(0));   // now -> outside 5 min
  const g2 = await db.query(`SELECT 1 FROM alert_groups WHERE device_id = $1`, [v2]);
  check(g2.rows.length === 0, 'members outside the 5 min window are NOT flagged');
  const sweep = await sweepExpiredCombos();
  check(sweep.expired >= 1, `stale partials swept (expired=${sweep.expired})`);

  await db.query(`DELETE FROM alert_combo_events WHERE device_id = $1`, [v2]).catch(() => {});
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}%`]).catch(() => {});

  // 5. Clean up everything this test created.
  await cleanup();
  const residue = await db.query(
    `SELECT
       (SELECT count(*)::int FROM alerts WHERE id LIKE $1) a,
       (SELECT count(*)::int FROM alert_groups WHERE device_id LIKE $2) g,
       (SELECT count(*)::int FROM alert_combo_events WHERE device_id LIKE $2) c,
       (SELECT count(*)::int FROM alert_group_configs WHERE name = $3) gc,
       (SELECT count(*)::int FROM alert_definitions WHERE signal_code LIKE $4) d`,
    [`${TAG}%`, `${TAG}%`, `${TAG} Combo`, `${TAG}-%`]
  );
  const r = residue.rows[0];
  check(r.a === 0 && r.g === 0 && r.c === 0 && r.gc === 0 && r.d === 0,
    `all smoke rows removed (alerts=${r.a} groups=${r.g} staging=${r.c} combos=${r.gc} defs=${r.d})`);

  console.log(ok ? '\nPROD-COMBO-SMOKE-OK' : '\nPROD-COMBO-SMOKE-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('PROD-COMBO-SMOKE-ERROR:', err.message);
  process.exit(1);
});