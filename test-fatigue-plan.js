'use strict';
// Unit tests for the fatigue/duration fire + re-arm rule (pure helpers).
// Run: node test-fatigue-plan.js   (no DB required)

const {
  planFatigueThresholds,
  baselineCrossedThresholds,
} = require('./src/services/deviceStatusPoller');

const THREE_H = 'a43F6lFwgIUq_gkgmgSX08g';
const SIX_H = 'aScBH27NHXUqTLcl8QcCo4g';
const EIGHT_H = 'aXmPcWqFx3kKp1XKdQDQEYQ';
const NINE_H = 'adT7lgnAOhEep8a1M4u09eg';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}
const codes = (plan) => plan.fire.map((t) => t.signalCode).sort();

console.log('[1] fire decisions');
{
  const p = planFatigueThresholds({ codes: [], curMinutes: 181, currDriving: true });
  check('181m crossing fires the 3h threshold once', codes(p).length === 1 && codes(p)[0] === THREE_H && p.rearm.length === 0, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [THREE_H], curMinutes: 181, currDriving: true });
  check('held 3h never refires while clock is still past 180', p.fire.length === 0 && p.rearm.length === 0, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [THREE_H], curMinutes: 500, currDriving: true });
  check('500m fires only the not-yet-served 6h + 8h', JSON.stringify(codes(p)) === JSON.stringify([EIGHT_H, SIX_H].sort()), JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [], curMinutes: 500, currDriving: false });
  check('not driving never fires', p.fire.length === 0, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [], curMinutes: 180, currDriving: true });
  check('boundary: exactly 180m fires', codes(p).length === 1 && codes(p)[0] === THREE_H, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [], curMinutes: 179.5, currDriving: true });
  check('boundary: 179.5m does not fire', p.fire.length === 0, JSON.stringify(p));
}

console.log('[2] re-arm (genuine new run)');
{
  const p = planFatigueThresholds({ codes: [THREE_H, SIX_H], curMinutes: 60, currDriving: true });
  check('clock dropped below thresholds → re-arm them', JSON.stringify(p.rearm.sort()) === JSON.stringify([THREE_H, SIX_H].sort()) && p.fire.length === 0, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [THREE_H], curMinutes: 10, currDriving: false });
  check('re-arm works while not driving', p.rearm.length === 1 && p.rearm[0] === THREE_H, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: [THREE_H], curMinutes: 200, currDriving: true });
  check('no re-arm while clock still above the threshold', p.rearm.length === 0 && p.fire.length === 0, JSON.stringify(p));
}

console.log('[3] degenerate input');
{
  const p = planFatigueThresholds({ codes: [THREE_H], curMinutes: null, currDriving: true });
  check('null duration → nothing changes', p.fire.length === 0 && p.rearm.length === 0, JSON.stringify(p));
}
{
  const p = planFatigueThresholds({ codes: null, curMinutes: 400, currDriving: true });
  check('non-array codes treated as empty', codes(p).length > 0, JSON.stringify(p));
}

console.log('[4] baseline (first sighting)');
{
  check('0m baseline is empty', JSON.stringify(baselineCrossedThresholds(0)) === '[]');
  check('179m baseline is empty', JSON.stringify(baselineCrossedThresholds(179)) === '[]');
  check('180m baseline pre-seeds 3h', JSON.stringify(baselineCrossedThresholds(180)) === JSON.stringify([THREE_H]));
  const full = baselineCrossedThresholds(545);
  check('545m baseline pre-seeds 3h+6h+8h+9h', [THREE_H, SIX_H, EIGHT_H, NINE_H].every((c) => full.includes(c)) && full.length === 4, JSON.stringify(full));
  check('garbage baseline is empty', JSON.stringify(baselineCrossedThresholds(NaN)) === '[]');
}

console.log('[5] full cycle: serve → reset → next batch');
{
  const held = [];
  const first = planFatigueThresholds({ codes: held, curMinutes: 545, currDriving: true });
  for (const t of first.fire) held.push(t.signalCode);
  check('run 1 serves 3h+6h+8h+9h together', first.fire.length === 4, JSON.stringify(first));

  const whileDriving = planFatigueThresholds({ codes: held, curMinutes: 560, currDriving: true });
  check('later in the same run: silent', whileDriving.fire.length === 0 && whileDriving.rearm.length === 0, JSON.stringify(whileDriving));

  const afterStop = planFatigueThresholds({ codes: held, curMinutes: 5, currDriving: false });
  check('clock restarted → whole batch re-armed', afterStop.rearm.length === 4, JSON.stringify(afterStop));
  for (const c of afterStop.rearm) held.splice(held.indexOf(c), 1);

  const run2 = planFatigueThresholds({ codes: held, curMinutes: 181, currDriving: true });
  check('run 2 fires 3h again (next batch works)', codes(run2).length === 1 && codes(run2)[0] === THREE_H, JSON.stringify(run2));
}

console.log('');
console.log(`fatigue-plan: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
