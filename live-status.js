// Live status check for the alert-platform work: confirms the deployed
// container actually carries each feature and that it is behaving.
process.env.DATABASE_URL = process.env.DATABASE_URL;

const combos = require('./src/services/alertCombos');
const ovr = require('./src/services/vehicleAlertOverrides');
const { resolveFleetExact } = require('./src/services/costCenterLookup');
const db = require('./src/db');

(async () => {
  const c = await combos.listEnabledCombos(null);
  console.log('combos active       :', c.length,
    c.map((x) => `${x.name} (${x.window_seconds}s)`).join(', '));

  await ovr.start();
  // loadOverrides() returns the current cache while a load is already in
  // flight, so poll until it is actually populated instead of racing it.
  let cache = await ovr.loadOverrides();
  for (let i = 0; i < 20 && cache.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
    cache = await ovr.loadOverrides();
  }
  console.log('overrides loaded    :', cache.size, 'entries');
  console.log('  RH23 Camera Occlusion suppressed:', ovr.isSuppressedSync({ deviceName: 'RH23 - GGD359X', alertName: 'Camera Occlusion' }));
  console.log('  PB30 Camera Occlusion suppressed:', ovr.isSuppressedSync({ deviceName: 'PB30 - JHD717FS', alertName: 'Camera Occlusion' }));
  console.log('  FM10 (not overridden) suppressed:', ovr.isSuppressedSync({ deviceName: 'FM10 - LDG067MP', alertName: 'Camera Occlusion' }));

  const fleet = await resolveFleetExact({ deviceId: '221087891635', deviceName: 'FM10 - LDG067MP' });
  console.log('cc attribution      : fleet resolved from camera name =', fleet);

  const d = await db.query(
    `SELECT column_default FROM information_schema.columns
     WHERE table_name='alert_group_configs' AND column_name='combo_enabled'`
  );
  console.log('combo default       :', d.rows[0]?.column_default);

  const s = await db.query(
    `SELECT
       (SELECT count(*)::int FROM information_schema.tables WHERE table_name='alert_combo_events') staging_table,
       (SELECT count(*)::int FROM information_schema.columns WHERE table_name='alerts' AND column_name='combo_state') combo_state_col,
       (SELECT count(*)::int FROM alert_group_configs WHERE combo_enabled) combos_on,
       (SELECT count(*)::int FROM alert_groups WHERE resolved=FALSE AND false_alert=FALSE) open_groups,
       (SELECT count(*)::int FROM alert_groups WHERE created_at > NOW() - INTERVAL '15 minutes') groups_15m,
       (SELECT count(*)::int FROM alerts WHERE combo_state='pending') held_pending,
       (SELECT count(*)::int FROM alert_groups WHERE alarm_type ILIKE 'Fatigue Detected%') merged_combos_raised`
  );
  const r = s.rows[0];
  console.log('schema              : staging_table=' + r.staging_table + ' combo_state_col=' + r.combo_state_col);
  console.log('combos on           :', r.combos_on);
  console.log('open groups         :', r.open_groups, '| created last 15m:', r.groups_15m);
  console.log('held (pending)      :', r.held_pending);
  console.log('merged combos raised:', r.merged_combos_raised);

  await db.closePool();
  process.exit(0);
})().catch((e) => {
  console.error('STATUS-ERROR:', e.message);
  process.exit(1);
});