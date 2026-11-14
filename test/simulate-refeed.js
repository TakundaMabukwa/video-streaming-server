/* ============================================================================
 * Local simulation of the conditions that produced backdated alerts:
 *   - Geotab re-publishes a modified record (same activeFrom, new record id)
 *   - container restart re-drains the feed window
 *   - a fleet rename changes the resolved device_id
 *
 * Runs the REAL ingest path (processGeotabEventBatch) against an isolated
 * local database (eps_alerts_fixtest). No Geotab network calls: the device
 * map is injected and rule names come from the event payload.
 *
 * S13–S19 additionally cover additive combos: a member detection always
 * raises its own individual card, and a completed combo raises its merged
 * card on top (telematics feed, video batch, DeviceStatus poller).
 *
 * Run:  node test/simulate-refeed.js
 * ==========================================================================*/

// Load .env first, then point the app at the isolated test DB before any
// module captures config.
require('dotenv').config();
process.env.DATABASE_URL = String(process.env.DATABASE_URL || '').replace(
  /\/[^/?]+$/,
  '/eps_alerts_fixtest'
);

const db = require('../src/db');
const { processGeotabEventBatch } = require('../src/services/geotabPolling');
const identity = require('../src/vehicles/identity');

const DEVICE = 'b778';
const PLATE = 'KRJ597MP';
const CC = 2;

const RULES = {
  unauthorized: { code: 'asLcTB8d1EE2phvPDrH65sA', name: 'Unauthorized Stop >0mins' },
  lens: { code: 'aEm4RV_iYM02S34IlsVGitA', name: 'Lens obstruction' },
  fatigue: { code: 'a43F6lFwgIUq_gkgmgSX08g', name: 'Driver Fatigue 3h (Low)' }, // poller-owned
  // Additive-combo fixtures (seeded after S12).
  comboA: { code: 'simComboA', name: 'Combo Member A' },
  comboB: { code: 'simComboB', name: 'Combo Member B' },
};

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
}

let seq = 0;
function makeEvent({ device = DEVICE, rule, activeFrom, id }) {
  return {
    id: id || `sim-${++seq}`,
    device: { id: device },
    rule: { id: rule.code, name: rule.name },
    activeFrom: activeFrom.toISOString(),
    lastModifiedDateTime: new Date().toISOString(),
    duration: 'PT0S',
    distance: 0,
    latitude: -26.2,
    longitude: 28.0,
    speed: 40,
    address: 'Sim',
    driver: { name: 'Sim Driver' },
    diagnostic: null,
    zones: [],
  };
}

async function seed() {
  await db.query(`
    TRUNCATE TABLE telematics_events, alert_groups, alerts, vehicle_status,
      geotab_devices, fleet_vehicles, driver_scoring, cost_centers,
      alert_definitions, alert_definition_overrides, sync_state,
      vehicle_alert_overrides, alert_group_configs, alert_group_config_overrides,
      alert_group_config_members, jobs
    RESTART IDENTITY CASCADE
  `);
  await db.query(`INSERT INTO cost_centers (id, name, code, is_active) VALUES
                  (${CC}, 'Tyson Logistics', 'TYSON', true),
                  (99, 'No Combo CC', 'NOCOMBO', true)`);
  // Prod-faithful: registry already correct (226), Geotab device still tagged VOLVO.
  await db.query(`INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center, cost_center_id)
                  VALUES ('226', '${PLATE}', 'Volvo', 'FH', 'Tyson Logistics', ${CC})`);
  await db.query(`INSERT INTO geotab_devices (id, name, fleet_number, license_plate, serial_number, is_active, active_from)
                  VALUES ('${DEVICE}', '226 - VOLVO', 'VOLVO', '${PLATE}', 'SIM001', true, now())`);
  // Extra units for the burst scenario (a real burst covered ~177 devices).
  // 999 lives in a cost centre that never opts into the additive combo
  // fixtures. Seeded up front so the fleet-registry guard cache (loaded on the
  // first alert) already knows it.
  await db.query(`INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center, cost_center_id) VALUES
                  ('228', 'ABC123', 'Volvo', 'FH', 'Tyson Logistics', ${CC}),
                  ('Tetra 01', 'DEF456', 'Volvo', 'FH', 'Tyson Logistics', ${CC}),
                  ('777', 'POL777', 'Volvo', 'FH', 'Tyson Logistics', ${CC}),
                  ('999', 'XYZ999', 'Volvo', 'FH', 'No Combo CC', 99)`);
  await db.query(`INSERT INTO geotab_devices (id, name, fleet_number, license_plate, serial_number, is_active, active_from) VALUES
                  ('b652', '228 - VOLVO', '228', 'ABC123', 'SIM002', true, now()),
                  ('b758', 'Tetra 01 - VOLVO', 'Tetra 01', 'DEF456', 'SIM003', true, now()),
                  ('b777', '777 - VOLVO', '777', 'POL777', 'SIM777', true, now()),
                  ('b999', '999 - OTHER', '999', 'XYZ999', 'SIM999', true, now())`);
  await db.query(`
    INSERT INTO alert_definitions (id, name, category, signal_code, severity, is_active, is_global) VALUES
      (101, '${RULES.unauthorized.name}', 'telematics', '${RULES.unauthorized.code}', 'HIGH', true, true),
      (102, '${RULES.lens.name}', 'telematics', '${RULES.lens.code}', 'CRITICAL', true, true),
      (103, '${RULES.fatigue.name}', 'telematics', '${RULES.fatigue.code}', 'MEDIUM', true, true)
  `);
  await db.query(`
    INSERT INTO alert_definition_overrides (alert_definition_id, cost_center_id, is_active) VALUES
      (101, ${CC}, true), (102, ${CC}, true), (103, ${CC}, true)
  `);
  await db.query(`INSERT INTO sync_state (key, value) VALUES ('geotab_event_version', '"0000000000000000"')`);
}

async function feed(events) {
  const rows = await db.query('SELECT id, name, fleet_number, license_plate FROM geotab_devices');
  const deviceMap = new Map(rows.rows.map((d) => [d.id, d]));
  return processGeotabEventBatch(events, { credentials: {}, deviceMap });
}

async function snapshot() {
  const te = await db.query('SELECT id, device_id, fleet_number, source_device_id, event_code, event_time, created_at FROM telematics_events ORDER BY id');
  const ag = await db.query('SELECT id, device_id, alarm_type, count, last_alert_ts, created_at, resolved FROM alert_groups ORDER BY id');
  const al = await db.query('SELECT id, device_id, alarm_type, alarm_ts, created_at, alert_group_id FROM alerts ORDER BY id');
  return { te: te.rows, ag: ag.rows, al: al.rows };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);
const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000);

(async () => {
  await seed();
  console.log('\n=== S1: fresh feed creates a card (pre-rename, device resolves to VOLVO) ===');
  const T0 = hoursAgo(0.01); // one fixed instant shared by S1/S2/S3
  const s1 = await feed([makeEvent({ rule: RULES.unauthorized, activeFrom: T0 })]);
  let snap = await snapshot();
  check('S1 inserted=1', s1.inserted === 1, `inserted=${s1.inserted}`);
  check('S1 one group created', snap.ag.length === 1, `groups=${snap.ag.length}`);
  check('S1 group under resolved fleet VOLVO', snap.ag[0]?.device_id === 'VOLVO', `device_id=${snap.ag[0]?.device_id}`);
  check('S1 one member row', snap.al.length === 1, `members=${snap.al.length}`);
  check('S1 member id is tel-VOLVO-*', String(snap.al[0]?.id).startsWith('tel-VOLVO-'), `id=${snap.al[0]?.id}`);
  const s1Group = snap.ag[0];

  console.log('\n=== S2: rename Geotab fleet -> 226, then re-feed the SAME record ===');
  await db.query(`UPDATE geotab_devices SET fleet_number = '226' WHERE id = '${DEVICE}'`);
  identity.invalidate();
  const s2 = await feed([makeEvent({ rule: RULES.unauthorized, activeFrom: T0 })]);
  snap = await snapshot();
  check('S2 deduped by provider key (no insert)', s2.inserted === 0 && s2.dedupedSourceKey === 1,
    `inserted=${s2.inserted} dedupedSourceKey=${s2.dedupedSourceKey}`);
  check('S2 no new group', snap.ag.length === 1, `groups=${snap.ag.length}`);
  check('S2 no new member', snap.al.length === 1, `members=${snap.al.length}`);
  check('S2 existing group untouched (still VOLVO, count 1)', snap.ag[0].device_id === 'VOLVO' && snap.ag[0].count === 1,
    `device_id=${snap.ag[0].device_id} count=${snap.ag[0].count}`);

  console.log('\n=== S3: rename + Geotab re-publishes SAME logical event with a NEW record id ===');
  const s3 = await feed([makeEvent({ rule: RULES.unauthorized, activeFrom: T0 })]);
  snap = await snapshot();
  check('S3 deduped by (source_device, code, time) — record id irrelevant', s3.inserted === 0 && s3.dedupedSourceKey === 1,
    `inserted=${s3.inserted} dedupedSourceKey=${s3.dedupedSourceKey}`);
  check('S3 still one group / one member', snap.ag.length === 1 && snap.al.length === 1,
    `groups=${snap.ag.length} members=${snap.al.length}`);

  console.log('\n=== S4: backdated re-feed (3 days old, new record id) — archive only ===');
  const s4 = await feed([makeEvent({ rule: RULES.unauthorized, activeFrom: daysAgo(3) })]);
  snap = await snapshot();
  check('S4 staleArchived=1', s4.staleArchived === 1, `staleArchived=${s4.staleArchived}`);
  check('S4 archived into telematics_events', snap.te.length === 2, `archive rows=${snap.te.length}`);
  check('S4 no new group', snap.ag.length === 1, `groups=${snap.ag.length}`);
  check('S4 no new member', snap.al.length === 1, `members=${snap.al.length}`);
  check('S4 archive row keeps old event_time',
    new Date(snap.te[1].event_time).getTime() <= daysAgo(3).getTime() + 5000,
    `event_time=${snap.te[1].event_time}`);

  console.log('\n=== S5: poller-owned fatigue (fresh) is archive-only ===');
  const s5 = await feed([makeEvent({ rule: RULES.fatigue, activeFrom: hoursAgo(0.01) })]);
  snap = await snapshot();
  check('S5 inserted=1 (archived)', s5.inserted === 1, `inserted=${s5.inserted}`);
  check('S5 alerted=0 (poller owns it)', s5.alerted === 0, `alerted=${s5.alerted}`);
  check('S5 no group / no member', snap.ag.length === 1 && snap.al.length === 1,
    `groups=${snap.ag.length} members=${snap.al.length}`);

  console.log('\n=== S6: mixed restart re-drain — only fresh, non-owned records alert ===');
  const before = snap;
  const s6 = await feed([
    makeEvent({ rule: RULES.unauthorized, activeFrom: hoursAgo(0.02) }),  // fresh -> bumps existing group
    makeEvent({ rule: RULES.lens, activeFrom: hoursAgo(0.02) }),          // fresh -> new group under 226
    makeEvent({ rule: RULES.unauthorized, activeFrom: daysAgo(2) }),       // stale -> archive only
    makeEvent({ rule: RULES.lens, activeFrom: daysAgo(4) }),               // stale -> archive only
    makeEvent({ rule: RULES.fatigue, activeFrom: hoursAgo(0.02) }),        // poller-owned -> archive only
  ]);
  snap = await snapshot();
  check('S6 two stale archived', s6.staleArchived === 2, `staleArchived=${s6.staleArchived}`);
  check('S6 one poller-owned archived without alert', s6.inserted === 5 && s6.alerted >= 1,
    `inserted=${s6.inserted} alerted=${s6.alerted}`);
  check('S6 group count grew by exactly 2 (one per fresh non-owned event)',
    snap.ag.length === before.ag.length + 2,
    `groups ${before.ag.length} -> ${snap.ag.length} (no group from 2 stale or 1 poller-owned)`);
  check('S6 new group is under renamed fleet 226',
    snap.ag.some((g) => g.device_id === '226' && g.alarm_type === RULES.lens.name),
    `groups=${snap.ag.map((g) => `${g.device_id}:${g.alarm_type}`).join(', ')}`);
  check('S6 no stale record produced a member',
    snap.al.every((a) => Date.now() - new Date(a.alarm_ts).getTime() < 2 * 3600 * 1000),
    `max member age=${Math.max(...snap.al.map((a) => Date.now() - new Date(a.alarm_ts).getTime())) / 60000 | 0} min`);
  check('S6 no group was bumped by the stale/owned archive rows',
    snap.ag.every((g) => g.count === 1),
    `counts=${snap.ag.map((g) => g.count).join(',')}`);
  check('S6 old VOLVO group untouched (count still 1)',
    snap.ag.find((g) => g.device_id === 'VOLVO')?.count === 1,
    `VOLVO count=${snap.ag.find((g) => g.device_id === 'VOLVO')?.count}`);

  console.log('\n=== S7: genuinely new event after rename cards under 226 ===');
  const beforeS7 = snap;
  const s7 = await feed([makeEvent({ rule: RULES.lens, activeFrom: hoursAgo(0.01) })]);
  snap = await snapshot();
  const lens226 = snap.ag.find((g) => g.device_id === '226' && g.alarm_type === RULES.lens.name);
  check('S7 lens card under renamed fleet 226', !!lens226, `device_id=${lens226?.device_id}`);
  check('S7 member count grew by 1', snap.al.length === beforeS7.al.length + 1,
    `members ${beforeS7.al.length} -> ${snap.al.length}`);
  check('S7 new member id tel-226-*', snap.al.some((a) => String(a.id).startsWith('tel-226-')), '');
  check('S7 inserted=1', s7.inserted === 1, `inserted=${s7.inserted}`);

  console.log('\n=== S8: index race backstop — duplicate provider key cannot insert twice ===');
  const raceTime = hoursAgo(0.01);
  const s8a = await feed([makeEvent({ rule: RULES.unauthorized, activeFrom: raceTime })]);
  const raceRow = (await db.query(
    `SELECT source_device_id, event_code, event_time, device_id FROM telematics_events
      WHERE event_time = $1 AND event_code = $2`,
    [raceTime.toISOString(), RULES.unauthorized.code]
  )).rows[0];
  let raceThrew = null;
  try {
    // Simulate a concurrent worker that passed the pre-check a moment earlier.
    // Same statement shape as the real ingest (target-less DO NOTHING).
    await db.query(
      `INSERT INTO telematics_events (device_id, event_code, event_time, source_device_id, event_type, severity)
       VALUES ($1,$2,$3,$4,'race','HIGH')
       ON CONFLICT DO NOTHING`,
      [raceRow.device_id, raceRow.event_code, raceRow.event_time, raceRow.source_device_id]
    );
  } catch (e) { raceThrew = e; }
  const raceCount = (await db.query(
    'SELECT count(*)::int AS n FROM telematics_events WHERE event_time = $1 AND event_code = $2',
    [raceTime.toISOString(), RULES.unauthorized.code]
  )).rows[0].n;
  check('S8 first copy inserted', s8a.inserted === 1, `inserted=${s8a.inserted}`);
  check('S8 concurrent duplicate did not throw and did not duplicate', raceThrew === null && raceCount === 1,
    `threw=${raceThrew?.message || 'no'} rows=${raceCount}`);

  console.log('\n=== S9: legacy unique key still applies when provider id is NULL ===');
  const legacyTime = hoursAgo(0.02);
  await db.query(
    `INSERT INTO telematics_events (device_id, event_code, event_time, source_device_id, event_type, severity)
     VALUES ('226', 'legacyCode', $1, NULL, 'legacy', 'LOW')`, [legacyTime.toISOString()]
  );
  let legacyThrew = null;
  try {
    await db.query(
      `INSERT INTO telematics_events (device_id, event_code, event_time, source_device_id, event_type, severity)
       VALUES ('226', 'legacyCode', $1, NULL, 'legacy', 'LOW')
       ON CONFLICT DO NOTHING`, [legacyTime.toISOString()]
    );
  } catch (e) { legacyThrew = e; }
  const legacyCount = (await db.query(
    "SELECT count(*)::int AS n FROM telematics_events WHERE event_code='legacyCode'"
  )).rows[0].n;
  check('S9 legacy (device_id,code,time) duplicate blocked', legacyThrew === null && legacyCount === 1,
    `threw=${legacyThrew?.message || 'no'} rows=${legacyCount}`);

  console.log('\n=== S10: age boundary — 119 min alerts, 121 min archives only ===');
  const beforeS10 = await snapshot();
  const s10 = await feed([
    makeEvent({ rule: RULES.unauthorized, activeFrom: new Date(Date.now() - 119 * 60 * 1000) }),
    makeEvent({ rule: RULES.unauthorized, activeFrom: new Date(Date.now() - 121 * 60 * 1000) }),
  ]);
  snap = await snapshot();
  check('S10 both archived', s10.inserted === 2, `inserted=${s10.inserted}`);
  check('S10 only the 119-min record alerted', s10.staleArchived === 1 && s10.alerted === 1,
    `staleArchived=${s10.staleArchived} alerted=${s10.alerted}`);
  check('S10 fresh boundary event added exactly one member (bumped existing 226 card)',
    snap.al.length === beforeS10.al.length + 1,
    `members ${beforeS10.al.length} -> ${snap.al.length}`);

  console.log('\n=== S11: unknown device is archived but never alerts (stale or fresh) ===');
  const unknownBefore = snap;
  const s11 = await feed([
    makeEvent({ device: 'ghost-unit-999', rule: RULES.unauthorized, activeFrom: hoursAgo(0.01) }),
    makeEvent({ device: 'ghost-unit-999', rule: RULES.unauthorized, activeFrom: daysAgo(5) }),
  ]);
  snap = await snapshot();
  check('S11 unknown device rows archived', s11.inserted === 2, `inserted=${s11.inserted}`);
  check('S11 5-day-old unknown row treated as stale', s11.staleArchived === 1, `staleArchived=${s11.staleArchived}`);
  check('S11 no group/member from unknown device',
    snap.ag.length === unknownBefore.ag.length && snap.al.length === unknownBefore.al.length,
    `groups=${snap.ag.length} members=${snap.al.length}`);

  console.log('\n=== S12: burst re-drain — 60 records / 3 devices, half backdated ===');
  const burstBefore = await snapshot();
  const burstEvents = [];
  const burstDevices = [DEVICE, 'b652', 'b758'];
  for (const dev of burstDevices) {
    for (let k = 0; k < 10; k++) {
      burstEvents.push(makeEvent({ device: dev, rule: RULES.lens, activeFrom: new Date(Date.now() - (k + 1) * 2 * 60 * 1000) }));
      burstEvents.push(makeEvent({ device: dev, rule: RULES.lens, activeFrom: daysAgo(3 + k) }));
    }
  }
  const s12 = await feed(burstEvents);
  snap = await snapshot();
  const burstNewGroups = snap.ag.length - burstBefore.ag.length;
  const burstNewMembers = snap.al.length - burstBefore.al.length;
  check('S12 all 60 archived', s12.inserted === 60, `inserted=${s12.inserted}`);
  check('S12 exactly 30 backdated records gated', s12.staleArchived === 30, `staleArchived=${s12.staleArchived}`);
  check('S12 only fresh records alerted', s12.alerted === 30, `alerted=${s12.alerted}`);
  check('S12 30 fresh members added, 0 from stale', burstNewMembers === 30,
    `members ${burstBefore.al.length} -> ${snap.al.length}`);
  check('S12 exactly 2 new groups (the two units with no lens card yet)', burstNewGroups === 2,
    `groups ${burstBefore.ag.length} -> ${snap.ag.length}`);
  check('S12 no group carries a backdated member',
    snap.al.every((a) => Date.now() - new Date(a.alarm_ts).getTime() < 2 * 3600 * 1000),
    `max member age=${Math.max(...snap.al.map((a) => Date.now() - new Date(a.alarm_ts).getTime())) / 60000 | 0} min`);

  // ── Additive combo coverage (S13–S18) ──────────────────────────────────────
  // Seeded only now so the 5-minute combo windows cannot change the dedupe /
  // freshness expectations of S1–S12.
  console.log('\n=== Seeding additive-combo fixtures ===');
  const COMBO_NAME = 'Additive Combo (Test)';
  const COMBO_ID = 501;
  const CC_NO_COMBO = 99;
  const DEF_COMBO_A = 201;
  const DEF_COMBO_B = 202;

  await db.query(`
    INSERT INTO alert_definitions (id, name, category, signal_code, severity, is_active, is_global) VALUES
      (${DEF_COMBO_A}, '${RULES.comboA.name}', 'telematics', '${RULES.comboA.code}', 'HIGH', true, true),
      (${DEF_COMBO_B}, '${RULES.comboB.name}', 'telematics', '${RULES.comboB.code}', 'MEDIUM', true, true)
  `);
  await db.query(`
    INSERT INTO alert_definition_overrides (alert_definition_id, cost_center_id, is_active) VALUES
      (${DEF_COMBO_A}, ${CC}, true), (${DEF_COMBO_B}, ${CC}, true),
      (${DEF_COMBO_A}, ${CC_NO_COMBO}, true), (${DEF_COMBO_B}, ${CC_NO_COMBO}, true)
  `);
  await db.query(`
    INSERT INTO alert_group_configs (id, name, severity, description, is_active, combo_enabled, combo_window_seconds)
    VALUES (${COMBO_ID}, '${COMBO_NAME}', 'HIGH', 'additive-combo simulation', true, true, 300)
  `);
  await db.query(`
    INSERT INTO alert_group_config_members (group_config_id, alert_definition_id) VALUES
      (${COMBO_ID}, ${DEF_COMBO_A}), (${COMBO_ID}, ${DEF_COMBO_B})
  `);
  await db.query(`
    INSERT INTO alert_group_config_overrides (group_config_id, cost_center_id, is_active)
    VALUES (${COMBO_ID}, ${CC}, true)
  `);
  require('../src/db/alert_definitions').invalidateCache();
  require('../src/services/alertCombos').invalidate();

  const alertGroupFor = async (deviceId, alarmType) => (await db.query(
    `SELECT * FROM alert_groups WHERE device_id = $1 AND alarm_type = $2
     ORDER BY last_alert_ts DESC NULLS LAST, id DESC LIMIT 1`,
    [deviceId, alarmType]
  )).rows[0] || null;

  console.log('\n=== S13: combo member still raises its own individual card (staged, hidden) ===');
  const comboATime = new Date(Date.now() - 30 * 1000);
  const s13 = await feed([makeEvent({ rule: RULES.comboA, activeFrom: comboATime })]);
  const aGroup = await alertGroupFor('226', RULES.comboA.name);
  const stagedA = (await db.query(
    `SELECT state FROM alert_combo_events WHERE device_id = '226' AND alarm_type = $1 ORDER BY id DESC LIMIT 1`,
    [RULES.comboA.name]
  )).rows[0];
  const memberA = (await db.query(
    `SELECT combo_state, alert_group_id FROM alerts WHERE alarm_type = $1 ORDER BY alarm_ts DESC LIMIT 1`,
    [RULES.comboA.name]
  )).rows[0];
  check('S13 individual card raised for the combo member', !!aGroup && aGroup.count >= 1,
    `group=${aGroup ? `#${aGroup.id} count=${aGroup.count}` : 'none'}`);
  check('S13 combo member staged pending', stagedA?.state === 'pending', `state=${stagedA?.state || 'none'}`);
  check('S13 member stays hidden while pending (combo_state=pending)', memberA?.combo_state === 'pending',
    `combo_state=${memberA?.combo_state}`);
  check('S13 no merged combo card before the pair', !(await alertGroupFor('226', COMBO_NAME)),
    `combo=${(await alertGroupFor('226', COMBO_NAME))?.id || 'none'}`);
  check('S13 ingest still reports the individual card', s13.alerted === 1, `alerted=${s13.alerted}`);
  const pendingMembers = await db.getGroupMembers(aGroup?.id ?? -1);
  check('S13 pending detection stays hidden from the individual card member list',
    pendingMembers.rows.length === 0, `members=${pendingMembers.rows.length}`);

  console.log('\n=== S14: second member completes the combo — individual + combo cards coexist ===');
  const comboBTime = new Date(Date.now() - 20 * 1000);
  const s14 = await feed([makeEvent({ rule: RULES.comboB, activeFrom: comboBTime })]);
  const bGroup = await alertGroupFor('226', RULES.comboB.name);
  const comboCard = await alertGroupFor('226', COMBO_NAME);
  const linked = (await db.query(
    `SELECT count(*)::int AS n FROM alerts
      WHERE alarm_type = ANY($1::text[]) AND alert_group_id = $2 AND combo_state IS NULL`,
    [[RULES.comboA.name, RULES.comboB.name], comboCard?.id ?? -1]
  )).rows[0];
  const staging226 = (await db.query(
    `SELECT state FROM alert_combo_events WHERE device_id = '226' ORDER BY id`
  )).rows;
  check('S14 individual card raised for the second member', !!bGroup, `group=${bGroup?.id || 'none'}`);
  check('S14 first member’s individual card still present', !!aGroup, `group=${aGroup?.id || 'none'}`);
  check('S14 merged combo card raised with both members', !!comboCard && comboCard.count === 2,
    `group=${comboCard?.id || 'none'} count=${comboCard?.count}`);
  check('S14 completed members linked to the combo card (not merged into individual card)',
    linked.n === 2, `linked=${linked.n}`);
  check('S14 staging rows retired to linked', staging226.length === 2 && staging226.every((r) => r.state === 'linked'),
    `states=${staging226.map((r) => r.state).join(',')}`);
  check('S14 individual cards keep their own counts (no merge)',
    aGroup?.count >= 1 && bGroup?.count >= 1, `A=${aGroup?.count} B=${bGroup?.count}`);
  check('S14 ingest reports both cards', s14.alerted === 2, `alerted=${s14.alerted}`);
  const comboMembers = await db.getGroupMembers(comboCard?.id ?? -1);
  const indAMembers = await db.getGroupMembers(aGroup?.id ?? -1);
  const indBMembers = await db.getGroupMembers(bGroup?.id ?? -1);
  check('S14 combo card member list holds both completed detections', comboMembers.rows.length === 2,
    `members=${comboMembers.rows.length}`);
  check('S14 completed detections are not duplicated on the individual cards',
    indAMembers.rows.length === 0 && indBMembers.rows.length === 0,
    `A=${indAMembers.rows.length} B=${indBMembers.rows.length}`);

  console.log('\n=== S15: lone member outside the window — individual only, staging expires ===');
  const loneTime = new Date(Date.now() - 6 * 60 * 1000); // fresh for Fix 1, outside the 300s combo window
  const beforeS15 = await alertGroupFor('226', RULES.comboA.name);
  const comboCountBeforeS15 = (await alertGroupFor('226', COMBO_NAME))?.count;
  const loneEvent = makeEvent({ rule: RULES.comboA, activeFrom: loneTime, id: 'sim-lone-a' });
  const s15 = await feed([loneEvent]);
  const loneAlertId = `tel-226-${loneEvent.id}`;
  const afterS15 = await alertGroupFor('226', RULES.comboA.name);
  const loneMember = (await db.query(
    `SELECT id, combo_state, alert_group_id FROM alerts WHERE id = $1`, [loneAlertId]
  )).rows[0];
  const loneStage = (await db.query(
    `SELECT id, state FROM alert_combo_events WHERE alert_id = $1`, [loneAlertId]
  )).rows[0];
  check('S15 lone member still bumps its individual card',
    !!afterS15 && afterS15.count === (beforeS15?.count || 0) + 1,
    `count ${beforeS15?.count} -> ${afterS15?.count}`);
  check('S15 lone member staged pending', loneStage?.state === 'pending', `state=${loneStage?.state || 'none'}`);
  check('S15 no extra combo card from a lone member',
    (await alertGroupFor('226', COMBO_NAME))?.count === comboCountBeforeS15,
    `combo count=${(await alertGroupFor('226', COMBO_NAME))?.count}`);
  check('S15 ingest reports the individual card', s15.alerted === 1, `alerted=${s15.alerted}`);

  const sweep = await require('../src/services/alertCombos').sweep();
  const expiredStage = (await db.query(
    `SELECT state FROM alert_combo_events WHERE id = $1`, [loneStage?.id ?? -1]
  )).rows[0];
  const releasedMember = (await db.query(
    `SELECT combo_state, alert_group_id FROM alerts WHERE id = $1`, [loneMember?.id ?? 'none']
  )).rows[0];
  check('S15 sweep expires the stale staging row', sweep.expired >= 1 && expiredStage?.state === 'expired',
    `swept=${sweep.expired} state=${expiredStage?.state}`);
  check('S15 expired member released (combo_state cleared)', releasedMember?.combo_state == null,
    `combo_state=${releasedMember?.combo_state}`);
  check('S15 expired detection stays on its individual card',
    releasedMember?.alert_group_id === afterS15?.id,
    `alert_group_id=${releasedMember?.alert_group_id} individual=${afterS15?.id}`);
  const releasedList = await db.getGroupMembers(afterS15?.id ?? -1);
  check('S15 expired detection reappears in the individual card member list',
    releasedList.rows.some((r) => r.id === loneAlertId), `members=${releasedList.rows.length}`);

  console.log('\n=== S16: vehicle in a cost centre without the combo override — individual only ===');
  await feed([makeEvent({ device: 'b999', rule: RULES.comboA, activeFrom: new Date(Date.now() - 25 * 1000) })]);
  const noComboGroup = await alertGroupFor('999', RULES.comboA.name);
  const noComboStaged = (await db.query(
    `SELECT count(*)::int AS n FROM alert_combo_events WHERE device_id = '999'`
  )).rows[0];
  const noComboMember = (await db.query(
    `SELECT combo_state FROM alerts WHERE alarm_type = $1 AND device_id = '999' ORDER BY alarm_ts DESC LIMIT 1`,
    [RULES.comboA.name]
  )).rows[0];
  check('S16 individual card raised outside the combo cost-centre set', !!noComboGroup,
    `group=${noComboGroup?.id || 'none'}`);
  check('S16 no combo staging for an opted-out cost centre', noComboStaged.n === 0, `staged=${noComboStaged.n}`);
  check('S16 detection never hidden as pending', noComboMember?.combo_state == null,
    `combo_state=${noComboMember?.combo_state}`);
  check('S16 no merged combo card for that vehicle', !(await alertGroupFor('999', COMBO_NAME)),
    `combo=${(await alertGroupFor('999', COMBO_NAME))?.id || 'none'}`);

  console.log('\n=== S17: video batch path — combo gate is additive (individual + combo cards) ===');
  const { applyVideoComboGate } = require('../src/services/syncService');
  const videoAId = 'vid-combo-a-1';
  const videoBId = 'vid-combo-b-1';
  const videoRecords = [
    { id: videoAId, deviceId: '228', deviceName: '228', alarmType: RULES.comboA.name,
      alarmText: 'video member A', alarmTs: new Date(Date.now() - 30 * 1000).toISOString(), severity: 'high' },
    { id: videoBId, deviceId: '228', deviceName: '228', alarmType: RULES.comboB.name,
      alarmText: 'video member B', alarmTs: new Date(Date.now() - 20 * 1000).toISOString(), severity: 'medium' },
  ];
  await db.batchUpsertAlerts(videoRecords.map((r) => ({
    id: r.id, deviceId: r.deviceId, deviceName: r.deviceName,
    alarmType: r.alarmType, alarmTs: r.alarmTs, alarmText: r.alarmText,
    severity: r.severity, fleetNumber: '228',
  })));
  const comboRaised = await applyVideoComboGate(videoRecords);
  const videoGroupRows = await db.batchUpsertAlertGroups(videoRecords.map((r) => ({
    deviceId: r.deviceId, sourceDeviceId: r.deviceId, deviceName: r.deviceName,
    alarmType: r.alarmType, alarmText: r.alarmText, alertId: r.id,
    alarmTs: r.alarmTs, severity: r.severity, fleetNumber: '228',
    registration: 'ABC123', sourceType: 'video', costCenterId: CC,
  })));
  const videoComboCard = await alertGroupFor('228', COMBO_NAME);
  const videoIndA = await alertGroupFor('228', RULES.comboA.name);
  const videoIndB = await alertGroupFor('228', RULES.comboB.name);
  const videoLinked = (await db.query(
    `SELECT count(*)::int AS n FROM alerts
      WHERE id = ANY($1::text[]) AND alert_group_id = $2 AND combo_state IS NULL`,
    [[videoAId, videoBId], videoComboCard?.id ?? -1]
  )).rows[0];
  check('S17 video combo gate returned the merged group',
    comboRaised.length === 1 && comboRaised[0]?.alarm_type === COMBO_NAME,
    `raised=${comboRaised.length} type=${comboRaised[0]?.alarm_type}`);
  check('S17 both individual video cards raised alongside the combo', !!videoIndA && !!videoIndB,
    `A=${videoIndA?.id || 'none'} B=${videoIndB?.id || 'none'}`);
  check('S17 video batch upsert produced the individual rows', videoGroupRows.length === 2,
    `rows=${videoGroupRows.length}`);
  check('S17 merged video combo card exists with both members', videoComboCard?.count === 2,
    `count=${videoComboCard?.count}`);
  check('S17 completed video members linked to the combo card', videoLinked.n === 2,
    `linked=${videoLinked.n}`);

  console.log('\n=== S18: completion order is irrelevant (B before A) ===');
  await feed([makeEvent({ device: 'b758', rule: RULES.comboB, activeFrom: new Date(Date.now() - 28 * 1000) })]);
  const reversedNoCard = await alertGroupFor('TETRA 01', COMBO_NAME);
  await feed([makeEvent({ device: 'b758', rule: RULES.comboA, activeFrom: new Date(Date.now() - 18 * 1000) })]);
  const reversedCard = await alertGroupFor('TETRA 01', COMBO_NAME);
  const reversedIndA = await alertGroupFor('TETRA 01', RULES.comboA.name);
  const reversedIndB = await alertGroupFor('TETRA 01', RULES.comboB.name);
  check('S18 no combo card on the first member alone', !reversedNoCard,
    `combo=${reversedNoCard?.id || 'none'}`);
  check('S18 combo card raised when the pair completes in reverse order', reversedCard?.count === 2,
    `count=${reversedCard?.count}`);
  check('S18 both individual cards still raised in reverse order', !!reversedIndA && !!reversedIndB,
    `A=${reversedIndA?.id || 'none'} B=${reversedIndB?.id || 'none'}`);

  console.log('\n=== S19: DeviceStatus poller path is additive too ===');
  const { emitDeviceStatusAlert } = require('../src/services/deviceStatusPoller');
  const pollA = await emitDeviceStatusAlert({
    deviceId: 'b777', fleetNumber: '777', licensePlate: 'POL777',
    signalCode: RULES.comboA.code, alarmText: 'poller member A',
    lat: -26.2, lon: 28.0, speed: 40,
    ts: new Date(Date.now() - 30 * 1000).toISOString(),
  });
  const pollComboBeforeB = await alertGroupFor('777', COMBO_NAME);
  const pollB = await emitDeviceStatusAlert({
    deviceId: 'b777', fleetNumber: '777', licensePlate: 'POL777',
    signalCode: RULES.comboB.code, alarmText: 'poller member B',
    lat: -26.2, lon: 28.0, speed: 40,
    ts: new Date(Date.now() - 20 * 1000).toISOString(),
  });
  const pollIndA = await alertGroupFor('777', RULES.comboA.name);
  const pollIndB = await alertGroupFor('777', RULES.comboB.name);
  const pollCombo = await alertGroupFor('777', COMBO_NAME);
  const pollLinked = (await db.query(
    `SELECT count(*)::int AS n FROM alerts
      WHERE device_id = '777' AND alarm_type = ANY($1::text[]) AND alert_group_id = $2 AND combo_state IS NULL`,
    [[RULES.comboA.name, RULES.comboB.name], pollCombo?.id ?? -1]
  )).rows[0];
  check('S19 poller raised the first individual card even while staged', !!pollA && !!pollIndA,
    `return=${pollA ? 'row' : 'null'} group=${pollIndA?.id || 'none'}`);
  check('S19 no combo card from the first poller member alone', !pollComboBeforeB,
    `combo=${pollComboBeforeB?.id || 'none'}`);
  check('S19 poller raised the second individual card too', !!pollB && !!pollIndB,
    `return=${pollB ? 'row' : 'null'} group=${pollIndB?.id || 'none'}`);
  check('S19 poller combo card complete', pollCombo?.count === 2, `count=${pollCombo?.count}`);
  check('S19 poller members linked to the combo card', pollLinked.n === 2, `linked=${pollLinked.n}`);

  console.log(`\n=== RESULT: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`);
  await db.closePool();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('SIMULATION ERROR:', e.stack || e.message);
  try { await db.closePool(); } catch {}
  process.exit(1);
});
