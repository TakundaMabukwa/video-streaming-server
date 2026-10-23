// Integration test for AND-combination alert groups driven through the REAL
// ingestion path (deviceStatusPoller.emitDeviceStatusAlert), not the combo
// service directly. This proves the wiring in the call sites actually holds an
// alert back and that the merged group looks like a normal alert downstream.
//
// Coverage:
//   1. combo disabled      -> detection raises its own group, exactly as before
//   2. combo enabled       -> first member held back, nothing on the board
//   3. second member       -> ONE merged group, both members linked
//   4. repeated bursts     -> one group, count climbs (live-row dedup)
//   5. repeated same member-> staged once, no double count
//   6. window lapses       -> expires, no group, alert becomes normal again
//   7. per-vehicle         -> two vehicles assemble independently
//   8. strict CC rule      -> combo not in the CC's set -> members fire alone
//   9. one detection, two combos -> only one combo consumes it
//  10. closing the merged group -> cascades to every member
//  11. media survives expiry -> alert_media rows are never destroyed
//  12. members are readable through the same query the timeline uses
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';

const db = require('./src/db');
const alertCombos = require('./src/services/alertCombos');
const { sweepExpiredCombos } = require('./src/db/combo_groups');
const { emitDeviceStatusAlert } = require('./src/services/deviceStatusPoller');
const { invalidateCache } = require('./src/db/alert_definitions');
const vehicleOverrides = require('./src/services/vehicleAlertOverrides');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const log = (m) => console.log(`\n=== ${m}`);

const TAG = 'e2ecombo';
const SIG = {
  a: `${TAG}-SIG-A`,
  b: `${TAG}-SIG-B`,
  c: `${TAG}-SIG-C`,
};
const CC_NAME = `${TAG} CC`;
const CC_NAME_OTHER = `${TAG} CC2`;

// Per-section reset: only the rows a section produced. The world (definitions,
// cost centers, vehicles) is created once by setupWorld().
async function cleanup() {
  await db.query(`DELETE FROM alert_combo_events WHERE device_id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM alert_media WHERE alert_id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM alert_groups WHERE device_id LIKE $1 OR group_key LIKE $2`, [`%${TAG}%`, `%${TAG}%`]);
  await db.query(`DELETE FROM telematics_events WHERE device_id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM alert_group_config_overrides WHERE group_config_id IN (
                   SELECT id FROM alert_group_configs WHERE name LIKE $1)`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_group_config_members WHERE group_config_id IN (
                   SELECT id FROM alert_group_configs WHERE name LIKE $1)`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_group_configs WHERE name LIKE $1`, [`${TAG}%`]);
}

// Full teardown, also used once before setup so a crashed run leaves nothing.
async function cleanupWorld() {
  await cleanup();
  await db.query(`DELETE FROM alert_definition_overrides WHERE alert_definition_id IN (
                   SELECT id FROM alert_definitions WHERE signal_code LIKE $1)`, [`${TAG}-SIG-%`]);
  await db.query(`DELETE FROM driver_scoring WHERE fleet_number LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM alert_definitions WHERE signal_code LIKE $1`, [`${TAG}-SIG-%`]);
  await db.query(`DELETE FROM cost_centers WHERE name IN ($1, $2)`, [CC_NAME, CC_NAME_OTHER]);
}

// Real alert definitions + a real cost center + real registered vehicles, so the
// ingestion path behaves exactly as it does in production.
async function setupWorld() {
  // cost_centers.id is a plain INTEGER primary key (no sequence), so pick free ids.
  const maxId = await db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM cost_centers`);
  const base = Number(maxId.rows[0].m) + 1;
  const ccId = base;
  const ccOtherId = base + 1;
  await db.query(
    `INSERT INTO cost_centers (id, name, code) VALUES ($1, $2, $3), ($4, $5, $6)`,
    [ccId, CC_NAME, TAG, ccOtherId, CC_NAME_OTHER, `${TAG}2`]
  );

  const names = { a: `${TAG} Alert A`, b: `${TAG} Alert B`, c: `${TAG} Alert C` };
  const defs = {};
  for (const [k, signal] of Object.entries(SIG)) {
    const d = await db.query(
      `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
       VALUES ($1, 'telematics', $2, $3, 'HIGH') RETURNING id, name, signal_code`,
      [names[k], 'e2e combo test', signal]
    );
    defs[k] = d.rows[0];
    // Definition must be IN both cost centers' alert sets (strict CC rule).
    await db.query(
      `INSERT INTO alert_definition_overrides (alert_definition_id, cost_center_id, severity, is_active)
       VALUES ($1, $2, 'HIGH', TRUE), ($1, $3, 'HIGH', TRUE)`,
      [defs[k].id, ccId, ccOtherId]
    );
  }

  // Two vehicles, both in the primary cost center.
  const vehicles = {};
  for (const key of ['v1', 'v2']) {
    const fleet = `${TAG}${key.toUpperCase()}`;
    await db.query(
      `INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center, cost_center_id)
       VALUES ($1, $2, 'Test', 'Test', $3, $4)`,
      [fleet, `${TAG}-${key.toUpperCase()}`, CC_NAME, ccId]
    );
    await db.query(
      `INSERT INTO driver_scoring (fleet_number, cost_center_id) VALUES ($1, $2)`,
      [fleet, ccId]
    );
    vehicles[key] = fleet;
  }

  invalidateCache();
  vehicleOverrides.invalidate();
  alertCombos.invalidate();
  return { ccId, ccOtherId, defs, vehicles };
}

// Create a combo group over the given definition keys.
async function makeCombo(defs, keys, { enabled, windowSeconds }) {
  const g = await db.query(
    `INSERT INTO alert_group_configs (name, severity, description, combo_enabled, combo_window_seconds)
     VALUES ($1, 'CRITICAL', 'e2e combo', $2, $3) RETURNING id`,
    [`${TAG} Combo ${keys.join('')}`, enabled, windowSeconds]
  );
  const combo = g.rows[0];
  const ids = keys.map((k) => defs[k].id);
  await db.query(
    `INSERT INTO alert_group_config_members (group_config_id, alert_definition_id) VALUES ${ids.map((_, i) => `($1, $${i + 2})`).join(', ')}`,
    [combo.id, ...ids]
  );
  alertCombos.invalidate();
  return combo;
}

// Put a combo in a cost center's group set (per-CC override).
async function applyComboToCc(comboId, ccId) {
  await db.query(
    `INSERT INTO alert_group_config_overrides (group_config_id, cost_center_id, severity, is_active)
     VALUES ($1, $2, 'CRITICAL', TRUE)`,
    [comboId, ccId]
  );
  alertCombos.invalidate();
}

// Push an alert through the REAL ingestion function.
async function push(def, fleet, { ts, tag } = {}) {
  const suffix = tag || String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const result = await emitDeviceStatusAlert({
    deviceId: fleet,
    fleetNumber: fleet,
    licensePlate: null,
    signalCode: def.signal_code,
    alarmText: `${def.name} triggered`,
    lat: -26.1,
    lon: 28.2,
    speed: 70,
    ts: ts || new Date().toISOString(),
  });
  return { result, alertId: `dst-${fleet}-${def.signal_code}-${suffix}` };
}

async function liveGroups(fleet) {
  const r = await db.query(
    `SELECT id, alarm_type, severity, count FROM alert_groups
     WHERE device_id = $1 AND resolved = FALSE AND false_alert = FALSE
     ORDER BY id`, [fleet]
  );
  return r.rows;
}

async function membersOf(groupId) {
  const r = await db.query(
    `SELECT id, alarm_type, alert_group_id FROM alerts WHERE alert_group_id = $1 ORDER BY alarm_ts`, [groupId]
  );
  return r.rows;
}

async function stagedRows(fleet) {
  const r = await db.query(
    `SELECT alarm_type, state FROM alert_combo_events WHERE device_id = $1 ORDER BY id`, [fleet]
  );
  return r.rows;
}

(async () => {
  await db.initializeDatabase();
  await cleanupWorld();
  const { ccId, ccOtherId, defs, vehicles } = await setupWorld();
  const v1 = vehicles.v1;
  const v2 = vehicles.v2;

  // ── 1. combo disabled: unchanged single-alert behaviour ─────────────
  log('1. combo disabled -> alert raises on its own');
  {
    await makeCombo(defs, ['a', 'b'], { enabled: false, windowSeconds: 300 });
    await push(defs.a, v1, { tag: 'd1' });
    const groups = await liveGroups(v1);
    check(groups.length === 1, `one group raised (got ${groups.length})`);
    check(groups[0].alarm_type === defs.a.name, `group is the member type (got "${groups[0].alarm_type}")`);
    check(groups[0].alarm_type !== `${TAG} Combo ab`, 'not named after the combo');
    // The group's severity must still come from the alert definition, not a
    // hardcoded fallback (a page refresh renders the lane from this column).
    check(String(groups[0].severity).toLowerCase() === 'high', `definition severity preserved (got ${groups[0].severity})`);
    const staged = await stagedRows(v1);
    check(staged.length === 0, 'nothing staged');
  }

  // ── 2. first member held back ───────────────────────────────────────
  log('2. combo enabled -> first member held back');
  {
    await cleanup();
    const combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(combo.id, ccId);

    await push(defs.a, v1, { tag: 'h1' });
    const groups = await liveGroups(v1);
    check(groups.length === 0, `nothing on the board (got ${groups.length} groups)`);

    const staged = await stagedRows(v1);
    check(staged.length === 1 && staged[0].state === 'pending', 'detection staged as pending');

    const row = await db.query(
      `SELECT combo_state, alert_group_id FROM alerts WHERE device_id = $1 AND alarm_type = $2`,
      [v1, defs.a.name]
    );
    check(row.rows.length === 1, 'detection row stored (evidence/history intact)');
    check(row.rows[0].combo_state === 'pending', 'marked pending');
    check(row.rows[0].alert_group_id === null, 'no group yet');

    const listed = await db.getAlertsPaginated({ pageSize: 100, pageIndex: 1, deviceIds: v1 });
    check(!listed.records.some((r) => r.alarm_type === defs.a.name), 'hidden from the alert list');
    check(listed.total === 0, 'not counted in the alert total');
  }

  // ── 3. second member -> merged group ────────────────────────────────
  log('3. second member in-window -> one merged group');
  {
    await push(defs.b, v1, { tag: 'h2' });
    const groups = await liveGroups(v1);
    check(groups.length === 1, `exactly one group (got ${groups.length})`);
    const g = groups[0];
    check(g.alarm_type === `${TAG} Combo ab`, `named after the combo (got "${g.alarm_type}")`);
    check(String(g.severity).toLowerCase() === 'critical', `combo severity (got ${g.severity})`);

    const members = await membersOf(g.id);
    check(members.length === 2, `both members linked (got ${members.length})`);
    check(new Set(members.map((m) => m.alarm_type)).size === 2, 'two distinct member types');

    const staged = await stagedRows(v1);
    check(staged.every((s) => s.state === 'linked'), 'staging rows linked');

    const listed = await db.getAlertsPaginated({ pageSize: 100, pageIndex: 1, deviceIds: v1 });
    check(listed.records.filter((r) => r.alarm_type === defs.a.name).length === 1, 'member A visible again after link');
    check(listed.total === 2, 'both members now visible (got ' + listed.total + ')');
    // Member rows keep their own definition severity (the timeline shows it).
    const memberRows = await db.query(
      `SELECT alarm_type, severity FROM alerts WHERE alert_group_id = $1`, [g.id]
    );
    check(memberRows.rows.every((r) => String(r.severity).toLowerCase() === 'high'),
      `members keep their definition severity (got ${memberRows.rows.map((r) => r.severity).join(',')})`);

    // The event archive still records each detection.
    const events = await db.query(`SELECT COUNT(*)::int c FROM telematics_events WHERE device_id = $1`, [v1]);
    check(events.rows[0].c === 2, `both detections archived in telematics_events (got ${events.rows[0].c})`);
  }

  // ── 4. repeat burst -> same group, count climbs ─────────────────────
  log('4. a second full burst reuses the open group');
  {
    await push(defs.a, v1, { tag: 'h3' });
    await push(defs.b, v1, { tag: 'h4' });
    const groups = await liveGroups(v1);
    check(groups.length === 1, 'still one live group');
    check(Number(groups[0].count) >= 2, `count incremented (got ${groups[0].count})`);
    const members = await membersOf(groups[0].id);
    check(members.length === 4, `all four detections linked (got ${members.length})`);
  }

  // ── 5. same member repeated before completion ───────────────────────
  log('5. same member repeated while still waiting');
  {
    await cleanup();
    const combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { tag: 'r1' });
    await push(defs.a, v1, { tag: 'r2' });
    await push(defs.a, v1, { tag: 'r3' });
    const groups = await liveGroups(v1);
    check(groups.length === 0, 'three repeats of member A still raise nothing');
    const rows = await db.query(`SELECT COUNT(*)::int c FROM alerts WHERE device_id = $1`, [v1]);
    check(rows.rows[0].c === 3, 'each repeat stored as its own detection (got ' + rows.rows[0].c + ')');
    await push(defs.b, v1, { tag: 'r4' });
    const after = await liveGroups(v1);
    check(after.length === 1, 'combo completes on B');
    const members = await membersOf(after[0].id);
    check(members.length === 4, 'all staged detections join the merged group (got ' + members.length + ')');
  }

  // ── 6. window lapses ────────────────────────────────────────────────
  log('6. window lapses -> expires, no group');
  {
    await cleanup();
    const combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 30 });
    await applyComboToCc(combo.id, ccId);
    const old = new Date(Date.now() - 120 * 1000).toISOString();
    await push(defs.a, v1, { ts: old, tag: 'x1' });

    const sweep = await sweepExpiredCombos();
    check(sweep.expired >= 1, `stale detection retired (expired=${sweep.expired})`);
    const groups = await liveGroups(v1);
    check(groups.length === 0, 'no group for an expired combo');
    const row = await db.query(`SELECT combo_state FROM alerts WHERE device_id = $1`, [v1]);
    check(row.rows[0].combo_state === null, 'released back to a normal alert');
    const listed = await db.getAlertsPaginated({ pageSize: 100, pageIndex: 1, deviceIds: v1 });
    check(listed.records.length === 1, 'visible as an ordinary alert again');

    // A member arriving after expiry starts a fresh window.
    await push(defs.a, v1, { tag: 'x2' });
    await push(defs.b, v1, { tag: 'x3' });
    check((await liveGroups(v1)).length === 1, 'a fresh window still completes the combo');
  }

  // ── 7. per-vehicle independence ─────────────────────────────────────
  log('7. two vehicles assemble independently');
  {
    await cleanup();
    const combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { tag: 'p1' });
    await push(defs.a, v2, { tag: 'p2' });
    await push(defs.b, v2, { tag: 'p3' });
    check((await liveGroups(v1)).length === 0, 'v1 still waiting');
    check((await liveGroups(v2)).length === 1, 'v2 completed on its own');
    await push(defs.b, v1, { tag: 'p4' });
    check((await liveGroups(v1)).length === 1, 'v1 completed separately');
  }

  // ── 8. strict CC rule ───────────────────────────────────────────────
  log('8. combo not in the CC group set -> members fire individually');
  {
    await cleanup();
    const combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(combo.id, ccOtherId); // applied to the OTHER cost center only

    await push(defs.a, v1, { tag: 'c1' });
    const groups = await liveGroups(v1);
    check(groups.length === 1, 'member A raised on its own (combo not in this CC)');
    check(groups[0].alarm_type === defs.a.name, 'not the combo name');
    const staged = await stagedRows(v1);
    check(staged.length === 0, 'nothing staged');
  }

  // ── 9. one detection, two combos ────────────────────────────────────
  log('9. one detection can only satisfy one combo');
  {
    await cleanup();
    const comboAB = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    const comboAC = await makeCombo(defs, ['a', 'c'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(comboAB.id, ccId);
    await applyComboToCc(comboAC.id, ccId);

    await push(defs.a, v1, { tag: 'm1' });
    await push(defs.b, v1, { tag: 'm2' });  // completes AB
    await push(defs.c, v1, { tag: 'm3' });  // would complete AC, but A is consumed

    const groups = await liveGroups(v1);
    const names = groups.map((g) => g.alarm_type).sort();
    check(groups.length === 1, `only one combo raised (got ${groups.length}: ${names.join('|')})`);
    check(names[0] === `${TAG} Combo ab`, `the completed combo won (got ${names[0]})`);

    const consumed = await db.query(
      `SELECT state FROM alert_combo_events WHERE device_id = $1 AND state = 'consumed'`, [v1]
    );
    check(consumed.rows.length >= 1, 'the shared detection was marked consumed in the other combo');
  }

  // ── 10 + 11 + 12. members, media and closure ────────────────────────
  log('10. members readable, media preserved, closure cascades');
  {
    await cleanup();
    const combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { tag: 'f1' });

    // Attach media to the held detection, then let it expire.
    const alertRow = await db.query(`SELECT id FROM alerts WHERE device_id = $1`, [v1]);
    const heldId = alertRow.rows[0].id;
    await db.query(
      `INSERT INTO alert_media (alert_id, file_url, file_type) VALUES ($1, $2, 'image')`,
      [heldId, 'https://example.test/clip.jpg']
    );

    await db.query(
      `UPDATE alerts SET alarm_ts = NOW() - INTERVAL '1 hour' WHERE id = $1`, [heldId]
    );
    await sweepExpiredCombos();
    const media = await db.query(`SELECT 1 FROM alert_media WHERE alert_id = $1`, [heldId]);
    check(media.rows.length === 1, 'captured media survives combo expiry');

    // Now complete the combo and use the exact query the timeline uses.
    await push(defs.b, v1, { tag: 'f2' });
    const g = (await liveGroups(v1))[0];
    const timeline = await db.query(
      `SELECT id, alarm_type, alert_group_id FROM alerts
       WHERE alert_group_id = $1 ORDER BY alarm_ts DESC NULLS LAST`, [g.id]
    );
    check(timeline.rows.length === 2, `timeline query returns both members (got ${timeline.rows.length})`);

    // Closing the merged group must resolve every member.
    await db.query(`UPDATE alert_groups SET resolved = TRUE, resolved_by = 'e2e', resolved_at = NOW() WHERE id = $1`, [g.id]);
    const after = await db.query(`SELECT resolved, resolved_by FROM alerts WHERE alert_group_id = $1`, [g.id]);
    check(after.rows.every((r) => r.resolved === true), 'every member resolved');
    check(after.rows.every((r) => r.resolved_by === 'e2e'), 'resolved_by propagated');
    check((await liveGroups(v1)).length === 0, 'group no longer live');
  }

  // ── 11. settings API validation + warnings endpoint ─────────────────
  log('11. settings API validates combo input and reports warnings');
  {
    await cleanup();
    const ctrl = require('./src/controllers/alertConfigController');

    const mkRes = () => {
      const r = { statusCode: 200, body: null };
      r.status = (c) => { r.statusCode = c; return r; };
      r.json = (b) => { r.body = b; return r; };
      r.send = () => r;
      return r;
    };

    // Combo needs at least two members.
    let res = mkRes();
    await ctrl.createAlertGroupConfig({
      body: { name: `${TAG} Combo 1`, severity: 'HIGH', member_ids: [defs.a.id], combo_enabled: true },
    }, res);
    check(res.statusCode === 400, `combo with 1 member rejected (got ${res.statusCode})`);
    check(/at least 2/i.test(res.body?.message || ''), 'rejection explains why');

    // Two members is accepted, and the window is normalised.
    res = mkRes();
    await ctrl.createAlertGroupConfig({
      body: { name: `${TAG} Combo 1`, severity: 'HIGH', member_ids: [defs.a.id, defs.b.id], combo_enabled: true, combo_window_seconds: 5 },
    }, res);
    check(res.statusCode === 200, `combo with 2 members accepted (got ${res.statusCode})`);
    const created = res.body?.data;
    check(created?.combo_enabled === true, 'stored as combo_enabled');
    check(Number(created?.combo_window_seconds) >= 30, `window floored at 30s (got ${created?.combo_window_seconds})`);

    // A passive group with a single member is still fine.
    res = mkRes();
    await ctrl.createAlertGroupConfig({
      body: { name: `${TAG} Combo Solo`, severity: 'LOW', member_ids: [defs.c.id], combo_enabled: false },
    }, res);
    check(res.statusCode === 200, 'passive group with 1 member still allowed');

    // Dropping an enabled combo below 2 members must be blocked.
    res = mkRes();
    await ctrl.updateAlertGroupConfig({
      params: { id: created.id },
      body: { member_ids: [defs.a.id] },
    }, res);
    check(res.statusCode === 400, `dropping below 2 members while combo is on is blocked (got ${res.statusCode})`);

    // Warnings: remove member C from the CC set and confirm it is reported.
    await ctrl.updateAlertGroupConfig({
      params: { id: created.id },
      body: { member_ids: [defs.a.id, defs.b.id, defs.c.id] },
    }, mkRes());
    // The combo must be IN the CC's group set for it to apply there at all.
    await ctrl.upsertGroupConfigOverride({
      params: { group_id: created.id },
      body: { cost_center_id: ccId, severity: 'CRITICAL', description: 'e2e', is_active: true },
    }, mkRes());
    await db.query(
      `UPDATE alert_definition_overrides SET is_active = FALSE
       WHERE alert_definition_id = $1 AND cost_center_id = $2`,
      [defs.c.id, ccId]
    );
    invalidateCache();
    alertCombos.invalidate();

    res = mkRes();
    await ctrl.listGroupComboWarnings({ query: { cost_center_id: String(ccId) } }, res);
    const warnings = res.body?.data || [];
    const forCombo = warnings.find((w) => w.id === created.id);
    check(Array.isArray(forCombo?.missing_member_names), 'warnings returned for the combo');
    check(forCombo?.missing_member_names?.includes(defs.c.name), 'the missing member is named');
    check(!forCombo?.missing_member_names?.includes(defs.a.name), 'in-set members are not flagged');
    check(forCombo?.member_names?.length === 3, 'all members listed');

    // In a CC where the combo is not in the group set, nothing is reported.
    res = mkRes();
    await ctrl.listGroupComboWarnings({ query: { cost_center_id: String(ccOtherId) } }, res);
    check((res.body?.data || []).length === 0, 'no warnings where the combo is not applied');
  }

  // ── 12. the time window itself (the core rule) ─────────────────────
  log('12. all members must occur inside the configured time range');
  {
    const at = (msAgo) => new Date(Date.now() - msAgo * 1000).toISOString();

    // Inside the range -> flagged.
    await cleanup();
    let combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 }); // 5 min
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { ts: at(240), tag: 'w1' }); // 4 min ago
    await push(defs.b, v1, { ts: at(0), tag: 'w2' });   // now  -> 4 min apart
    check((await liveGroups(v1)).length === 1, '5 min window: members 4 min apart ARE flagged');

    // Outside the range -> not flagged.
    await cleanup();
    combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 300 });
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { ts: at(360), tag: 'w3' }); // 6 min ago
    await push(defs.b, v1, { ts: at(0), tag: 'w4' });   // now  -> 6 min apart
    check((await liveGroups(v1)).length === 0, '5 min window: members 6 min apart are NOT flagged');
    const held = await stagedRows(v1);
    check(held.filter((h) => h.state === 'pending').length === 2, 'both held pending, waiting');

    // A wider range accepts what a narrow one rejected.
    await cleanup();
    combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 900 }); // 15 min
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { ts: at(360), tag: 'w5' });
    await push(defs.b, v1, { ts: at(0), tag: 'w6' });
    check((await liveGroups(v1)).length === 1, '15 min window: the same 6 min gap IS flagged');

    // A narrow range rejects what a wide one accepted.
    await cleanup();
    combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 60 }); // 1 min
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { ts: at(90), tag: 'w7' });
    await push(defs.b, v1, { ts: at(0), tag: 'w8' });
    check((await liveGroups(v1)).length === 0, '1 min window: members 90 s apart are NOT flagged');

    // Same range, well inside the limit.
    await cleanup();
    combo = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 60 });
    await applyComboToCc(combo.id, ccId);
    await push(defs.a, v1, { ts: at(30), tag: 'w9' });
    await push(defs.b, v1, { ts: at(0), tag: 'w10' });
    check((await liveGroups(v1)).length === 1, '1 min window: members 30 s apart ARE flagged');
  }

  // ── 13. each group uses ITS OWN window, side by side ───────────────
  log('13. two combos with different windows coexist and each uses its own');
  {
    const at = (msAgo) => new Date(Date.now() - msAgo * 1000).toISOString();
    await cleanup();
    // Section 11 removed C from the CC set on purpose; restore it here.
    await db.query(
      `UPDATE alert_definition_overrides SET is_active = TRUE
       WHERE alert_definition_id = $1 AND cost_center_id = $2`,
      [defs.c.id, ccId]
    );
    invalidateCache();
    alertCombos.invalidate();

    // Two combos over DIFFERENT member pairs, deliberately different windows.
    const strict = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 60 });   // 1 min
    const loose = await makeCombo(defs, ['b', 'c'], { enabled: true, windowSeconds: 1800 }); // 30 min
    await applyComboToCc(strict.id, ccId);
    await applyComboToCc(loose.id, ccId);
    alertCombos.invalidate();

    // A + B are 90 s apart: too far for the 1 min combo, fine for the 30 min one.
    // Only B+C can complete, so feed A and B and assert nothing raised.
    await push(defs.a, v1, { ts: at(90), tag: 'x1' });
    await push(defs.b, v1, { ts: at(0), tag: 'x2' });
    check((await liveGroups(v1)).length === 0, 'strict combo did not fire at 90 s apart');

    // Now C completes the loose combo.
    await push(defs.c, v1, { ts: at(0), tag: 'x3' });
    const groups = await liveGroups(v1);
    check(groups.length === 1, `only the loose combo raised (got ${groups.length})`);
    check(groups[0].alarm_type === `${TAG} Combo bc`, `the 30 min combo won (got ${groups[0].alarm_type})`);

    // Each group carries its OWN stored window, exactly as Settings shows it.
    const rows = await db.query(
      `SELECT id, name, combo_enabled, combo_window_seconds FROM alert_group_configs
       WHERE name LIKE $1 ORDER BY id`, [`${TAG}%`]
    );
    check(rows.rows.every((r) => r.combo_enabled === true), 'every test combo is stored as enabled');
    const strictRow = rows.rows.find((r) => r.name === `${TAG} Combo ab`);
    const looseRow = rows.rows.find((r) => r.name === `${TAG} Combo bc`);
    check(Number(strictRow?.combo_window_seconds) === 60, `the 1 min window persisted (got ${strictRow?.combo_window_seconds})`);
    check(Number(looseRow?.combo_window_seconds) === 1800, `the 30 min window persisted (got ${looseRow?.combo_window_seconds})`);

    // And the strict combo still fires on its own when its own window is met.
    await cleanup();
    const strict2 = await makeCombo(defs, ['a', 'b'], { enabled: true, windowSeconds: 60 });
    await applyComboToCc(strict2.id, ccId);
    await push(defs.a, v1, { ts: at(20), tag: 'x4' });
    await push(defs.b, v1, { ts: at(0), tag: 'x5' });
    const g2 = await liveGroups(v1);
    check(g2.length === 1 && g2[0].alarm_type === `${TAG} Combo ab`, 'strict combo fires on its own within its window');
  }

  await cleanupWorld();
  invalidateCache();
  vehicleOverrides.invalidate();

  console.log(ok ? '\nCOMBO-E2E-OK' : '\nCOMBO-E2E-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('COMBO-E2E-ERROR:', err);
  process.exit(1);
});