// Local E2E for AND-combination alert groups ("combos"):
//
//  1. combo disabled  -> a detection raises its own alert exactly as before
//  2. combo enabled   -> the first member is held back, nothing on the board
//  3. second member in-window -> ONE merged group, both members linked
//  4. members outside the window -> expired, no group ever created
//  5. closure of the merged group cascades to both members (trg_group_resolve)
//  6. a member that belongs to no combo is untouched
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';

const db = require('./src/db');
const alertCombos = require('./src/services/alertCombos');
const { sweepExpiredCombos } = require('./src/db/combo_groups');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const log = (m) => console.log(`--- ${m}`);

const TAG = 'combotest';
const DEV = `${TAG}-dev`;
const OTHER = `${TAG}-other`;

async function reset() {
  await db.query(`DELETE FROM alert_combo_events WHERE device_id IN ($1, $2)`, [DEV, OTHER]);
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}-%`]);
  await db.query(`DELETE FROM alert_groups WHERE group_key LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_group_config_overrides WHERE group_config_id IN (
                   SELECT id FROM alert_group_configs WHERE name LIKE $1)`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_group_config_members WHERE group_config_id IN (
                   SELECT id FROM alert_group_configs WHERE name LIKE $1)`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_group_configs WHERE name LIKE $1`, [`${TAG}%`]);
}

// Two throwaway alert definitions so the test never touches real alert types.
async function makeDefinitions() {
  const a = await db.query(
    `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
     VALUES ($1, 'telematics', 'combo test A', $2, 'HIGH')
     ON CONFLICT (signal_code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [`${TAG} Alert A`, `${TAG}-SIG-A`]
  );
  const b = await db.query(
    `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
     VALUES ($1, 'telematics', 'combo test B', $2, 'HIGH')
     ON CONFLICT (signal_code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [`${TAG} Alert B`, `${TAG}-SIG-B`]
  );
  return { a: a.rows[0], b: b.rows[0] };
}

async function makeCombo(defs, { enabled, windowSeconds }) {
  const g = await db.query(
    `INSERT INTO alert_group_configs (name, severity, description, combo_enabled, combo_window_seconds)
     VALUES ($1, 'CRITICAL', 'combo test group', $2, $3) RETURNING id, name, combo_enabled, combo_window_seconds`,
    [`${TAG} Combo`, enabled, windowSeconds]
  );
  const combo = g.rows[0];
  await db.query(
    `INSERT INTO alert_group_config_members (group_config_id, alert_definition_id) VALUES ($1, $2), ($1, $3)`,
    [combo.id, defs.a.id, defs.b.id]
  );
  alertCombos.invalidate();
  return combo;
}

async function detect({ alertId, deviceId, alarmType, ts }) {
  return alertCombos.handleDetection({
    alertId,
    deviceId,
    deviceName: `${deviceId} - TESTREG`,
    alarmType,
    alarmText: `${alarmType} (combo test)`,
    alarmTs: ts,
    lat: -26.1,
    lon: 28.2,
    speed: 60,
    severity: 'high',
    fleetNumber: 'PB29',
    sourceType: 'telematics',
    costCenterId: null, // CC-less vehicle -> global group scope
  });
}

(async () => {
  await db.initializeDatabase();
  const defs = await makeDefinitions();

  // ── 1. combo disabled: normal single-alert behaviour ────────────────
  log('combo disabled -> alert raises on its own');
  {
    await reset();
    await makeCombo(defs, { enabled: false, windowSeconds: 300 });
    const res = await detect({ alertId: `${TAG}-a1`, deviceId: DEV, alarmType: defs.a.name, ts: new Date().toISOString() });
    check(res.action === 'pass', `disabled combo passes through (got ${res.action})`);
    const staged = await db.query(`SELECT 1 FROM alert_combo_events WHERE device_id = $1`, [DEV]);
    check(staged.rows.length === 0, 'disabled combo stages nothing');
  }

  // ── 2. combo enabled: first member is held back ─────────────────────
  log('combo enabled -> first member held back');
  {
    await reset();
    await makeCombo(defs, { enabled: true, windowSeconds: 300 });

    const first = await detect({ alertId: `${TAG}-a1`, deviceId: DEV, alarmType: defs.a.name, ts: new Date().toISOString() });
    check(first.action === 'staged', `first member staged (got ${first.action})`);
    check(first.groupRows.length === 0, 'no group raised on the first member');

    const groups = await db.query(`SELECT 1 FROM alert_groups WHERE device_id = $1`, [DEV]);
    check(groups.rows.length === 0, 'nothing on the board for a partial combo');

    const stagedRow = await db.query(
      `SELECT a.combo_state, a.alert_group_id, ce.state
       FROM alerts a JOIN alert_combo_events ce ON ce.alert_id = a.id
       WHERE a.id = $1`, [`${TAG}-a1`]
    );
    check(stagedRow.rows.length === 1, 'detection row is stored for media/history');
    check(stagedRow.rows[0]?.combo_state === 'pending', 'detection row marked pending');
    check(stagedRow.rows[0]?.alert_group_id === null, 'detection row has no group yet');

    const hidden = await db.getAlertsPaginated({ pageSize: 50, pageIndex: 1, deviceIds: DEV });
    check(!hidden.records.some(r => r.id === `${TAG}-a1`), 'pending detection is hidden from the alert list');

    // ── 3. second member inside the window -> merged group ─────────────
    log('second member in-window -> one merged group');
    const second = await detect({ alertId: `${TAG}-b1`, deviceId: DEV, alarmType: defs.b.name, ts: new Date().toISOString() });
    check(second.action === 'raised', `combo raised (got ${second.action})`);
    check(second.groupRows.length === 1, 'exactly one merged group');

    const merged = await db.query(
      `SELECT id, alarm_type, severity, count, resolved, false_alert
       FROM alert_groups WHERE device_id = $1 AND resolved = FALSE`, [DEV]
    );
    check(merged.rows.length === 1, 'exactly one live group for the vehicle');
    const group = merged.rows[0];
    check(group.alarm_type === `${TAG} Combo`, `group is named after the combo (got "${group.alarm_type}")`);
    check(String(group.severity).toLowerCase() === 'critical', `group carries the combo severity (got ${group.severity})`);

    // Members are linked exactly like a single alert's members, so the
    // timeline / resolve / NCR flows work with no frontend change.
    const members = await db.query(
      `SELECT id, alarm_type, alert_group_id, combo_state FROM alerts
       WHERE device_id = $1 ORDER BY alarm_ts ASC`, [DEV]
    );
    const linked = members.rows.filter(r => r.alert_group_id === group.id);
    check(linked.length === 2, `both members linked to the merged group (got ${linked.length})`);
    check(members.rows.every(r => r.combo_state === null), 'member rows released from pending');
    check(new Set(linked.map(r => r.alarm_type)).size === 2, 'both distinct member types present');

    const staging = await db.query(
      `SELECT state FROM alert_combo_events WHERE device_id = $1`, [DEV]
    );
    check(staging.rows.every(r => r.state === 'linked'), 'staging rows marked linked');

    // ── 5. closure cascades to every member ───────────────────────────
    log('closing the merged group cascades to both members');
    await db.query(
      `UPDATE alert_groups SET resolved = TRUE, resolved_by = 'combotest', resolved_at = NOW() WHERE id = $1`,
      [group.id]
    );
    const after = await db.query(`SELECT resolved, resolved_by FROM alerts WHERE device_id = $1`, [DEV]);
    check(after.rows.length === 2, 'members still present after close');
    check(after.rows.every(r => r.resolved === true), 'closure cascaded to every member');
    check(after.rows.every(r => r.resolved_by === 'combotest'), 'resolved_by cascaded');
  }

  // ── 4. window lapses -> no group ─────────────────────────────────────
  log('window lapses -> detections expire without a group');
  {
    await reset();
    const combo = await makeCombo(defs, { enabled: true, windowSeconds: 30 });
    const old = new Date(Date.now() - 120 * 1000).toISOString();
    await detect({ alertId: `${TAG}-a1`, deviceId: DEV, alarmType: defs.a.name, ts: old });

    const sweep = await sweepExpiredCombos();
    check(sweep.expired >= 1, `sweep retired the stale detection (expired=${sweep.expired})`);

    const groups = await db.query(`SELECT 1 FROM alert_groups WHERE device_id = $1`, [DEV]);
    check(groups.rows.length === 0, 'no group created for an expired combo');

    const released = await db.query(`SELECT combo_state FROM alerts WHERE id = $1`, [`${TAG}-a1`]);
    check(released.rows[0]?.combo_state === null, 'expired detection released back to normal');

    const listed = await db.getAlertsPaginated({ pageSize: 50, pageIndex: 1, deviceIds: DEV });
    check(listed.records.some(r => r.id === `${TAG}-a1`), 'expired detection is visible again as an ordinary alert');

    // Same combo on a DIFFERENT vehicle is unaffected by the sweep.
    const other = await detect({ alertId: `${TAG}-a2`, deviceId: OTHER, alarmType: defs.a.name, ts: old });
    check(other.action === 'staged', 'other vehicle stages independently');
    await db.query(`DELETE FROM alert_combo_events WHERE device_id = $1`, [OTHER]);
    void combo;
  }

  // ── 6. a type in no combo is untouched ───────────────────────────────
  log('a type that is not a combo member is unaffected');
  {
    await reset();
    await makeCombo(defs, { enabled: true, windowSeconds: 300 });
    const res = await detect({ alertId: `${TAG}-a1`, deviceId: DEV, alarmType: 'Some Other Alert', ts: new Date().toISOString() });
    check(res.action === 'pass', 'unrelated alert type passes through');
    const staged = await db.query(`SELECT 1 FROM alert_combo_events WHERE device_id = $1`, [DEV]);
    check(staged.rows.length === 0, 'unrelated alert stages nothing');
  }

  await reset();
  await db.query(`DELETE FROM alert_definitions WHERE signal_code IN ($1, $2)`, [`${TAG}-SIG-A`, `${TAG}-SIG-B`]);

  console.log(ok ? '\nCOMBO-FLOW-OK' : '\nCOMBO-FLOW-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('COMBO-FLOW-ERROR:', err);
  process.exit(1);
});