'use strict';
// Local-only smoke test for the Reports "Closed Alerts" count.
// Run: docker compose cp check-closed-count.js server:/app/
//      MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/check-closed-count.js
const db = require('./src/db');

(async () => {
  const t0 = Date.now();
  const all = await db.getClosedAlertsCount({});
  const t1 = Date.now();
  const windowed = await db.getClosedAlertsCount({ from: '2026-01-01', to: '2026-12-31' });
  const t2 = Date.now();
  const some = await db.getClosedAlertsCount({ costCenterIds: ['5', '12'] });
  const t3 = Date.now();
  const none = await db.getClosedAlertsCount({ costCenterIds: ['99999'] });
  const resolved = await db.getResolvedAlertGroupCount();

  const checks = [
    ['count matches resolved baseline (no filters)', all === resolved, `${all} vs resolved ${resolved}`],
    ['date window ⊆ all', windowed <= all, `${windowed} <= ${all}`],
    ['cost-centre subset ≤ all', some <= all && some >= 0, `${some} <= ${all}`],
    ['unknown cost centre → 0', none === 0, String(none)],
    ['all-time query under 5s', t1 - t0 < 5000, `${t1 - t0}ms`],
    ['windowed query under 5s', t2 - t1 < 5000, `${t2 - t1}ms`],
    ['cc query under 5s', t3 - t2 < 5000, `${t3 - t2}ms`],
  ];
  let fail = 0;
  for (const [label, ok, detail] of checks) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : ` → ${detail}`));
    if (!ok) fail++;
  }
  console.log(`closed-count smoke: ${checks.length - fail} passed, ${fail} failed (all=${all}, cc5+12=${some})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
