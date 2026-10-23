// Verifies on a LIVE server that:
//   1. creating a group with 2 members and NO combo flag -> combination ON
//   2. the creator can set how long (the time window) at creation
//   3. the window can be changed afterwards
//   4. a 1-member group is never a dead combination
// Self-cleaning: every row it creates is removed at the end.
process.env.DATABASE_URL = process.env.DATABASE_URL;

const db = require('./src/db');
const ctrl = require('./src/controllers/alertConfigController');
const alertCombos = require('./src/services/alertCombos');

const TAG = 'createcheck';
let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = () => r;
  return r;
};

async function cleanup() {
  await db.query(`DELETE FROM alert_group_config_overrides WHERE group_config_id IN (
                     SELECT id FROM alert_group_configs WHERE name LIKE $1)`, [`${TAG}%`]).catch(() => {});
  await db.query(`DELETE FROM alert_group_config_members WHERE group_config_id IN (
                     SELECT id FROM alert_group_configs WHERE name LIKE $1)`, [`${TAG}%`]).catch(() => {});
  await db.query(`DELETE FROM alert_group_configs WHERE name LIKE $1`, [`${TAG}%`]).catch(() => {});
  await db.query(`DELETE FROM alert_definitions WHERE signal_code LIKE $1`, [`${TAG}-%`]).catch(() => {});
}

(async () => {
  await cleanup();

  const a = (await db.query(
    `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
     VALUES ($1,'telematics','create check',$2,'HIGH') RETURNING id, name`,
    [`${TAG} A`, `${TAG}-SIG-A`]
  )).rows[0];
  const b = (await db.query(
    `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
     VALUES ($1,'telematics','create check',$2,'HIGH') RETURNING id, name`,
    [`${TAG} B`, `${TAG}-SIG-B`]
  )).rows[0];

  // 1. No combo flag at all -> combination ON by default.
  let res = mkRes();
  await ctrl.createAlertGroupConfig({
    body: { name: `${TAG} Default On`, severity: 'HIGH', member_ids: [a.id, b.id] },
  }, res);
  check(res.statusCode === 200, `created (HTTP ${res.statusCode})`);
  const g1 = res.body?.data;
  check(g1?.combo_enabled === true, `combination is ON by default (got ${g1?.combo_enabled})`);
  check(Number(g1?.combo_window_seconds) === 300, `default window 5 min (got ${g1?.combo_window_seconds})`);
  check((g1?.members || []).length === 2, 'both members stored');

  // 2. The creator sets how long at creation time.
  res = mkRes();
  await ctrl.createAlertGroupConfig({
    body: { name: `${TAG} With Window`, severity: 'HIGH', member_ids: [a.id, b.id], combo_window_seconds: 1800 },
  }, res);
  const g2 = res.body?.data;
  check(res.statusCode === 200, 'created with an explicit window');
  check(Number(g2?.combo_window_seconds) === 1800, `window honoured as 30 min (got ${g2?.combo_window_seconds})`);

  // 3. Change the window afterwards.
  res = mkRes();
  await ctrl.updateAlertGroupConfig({
    params: { id: g2.id },
    body: { combo_window_seconds: 900 },
  }, res);
  check(Number(res.body?.data?.combo_window_seconds) === 900, `window updated to 15 min (got ${res.body?.data?.combo_window_seconds})`);

  // Out-of-range values are clamped, never stored raw.
  res = mkRes();
  await ctrl.updateAlertGroupConfig({
    params: { id: g2.id },
    body: { combo_window_seconds: 5 },
  }, res);
  check(Number(res.body?.data?.combo_window_seconds) === 30, `too small clamped to 30s (got ${res.body?.data?.combo_window_seconds})`);
  res = mkRes();
  await ctrl.updateAlertGroupConfig({
    params: { id: g2.id },
    body: { combo_window_seconds: 999999 },
  }, res);
  check(Number(res.body?.data?.combo_window_seconds) === 86400, `too large clamped to 24h (got ${res.body?.data?.combo_window_seconds})`);

  // 4. One member must never become a dead combination.
  res = mkRes();
  await ctrl.createAlertGroupConfig({
    body: { name: `${TAG} Solo`, severity: 'LOW', member_ids: [a.id] },
  }, res);
  check(res.body?.data?.combo_enabled === false, `1-member group is not a combination (got ${res.body?.data?.combo_enabled})`);

  // The setting is honoured by the detection layer, not just stored.
  alertCombos.invalidate();
  const combos = await alertCombos.listEnabledCombos(null);
  const mine = combos.filter((c) => String(c.name).startsWith(TAG));
  check(mine.length === 2, `detection layer sees both combinations (got ${mine.length})`);
  const withWindow = mine.find((c) => c.name === `${TAG} With Window`);
  check(Number(withWindow?.window_seconds) === 86400, `detection layer uses the stored window (got ${withWindow?.window_seconds})`);
  check(Array.isArray(withWindow?.member_names) && withWindow.member_names.length === 2, 'detection layer sees both members');

  await cleanup();
  const left = await db.query(
    `SELECT (SELECT count(*)::int FROM alert_group_configs WHERE name LIKE $1) g,
            (SELECT count(*)::int FROM alert_definitions WHERE signal_code LIKE $2) d`,
    [`${TAG}%`, `${TAG}-%`]
  );
  check(left.rows[0].g === 0 && left.rows[0].d === 0, `cleaned up (groups=${left.rows[0].g} defs=${left.rows[0].d})`);

  console.log(ok ? '\nCREATE-DEFAULT-OK' : '\nCREATE-DEFAULT-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('CREATE-DEFAULT-ERROR:', e.message);
  process.exit(1);
});