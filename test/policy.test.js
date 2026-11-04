'use strict';
// Pure policy tests: speeding source rules + zone category normalization.
const { geotabSpeedingPolicy, isPollerOwnedAlert, SPEED_85_CODE, SPEED_90_CODE } = require('../src/alerts/catalog');
const { categoryOf, entryLabel } = require('../src/alerts/zoneCategory');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

console.log('[speeding policy]');
check('Geotab 85 archive-only', geotabSpeedingPolicy({ name: 'Heavy Duty Max Speeding 85km/h', signalCode: SPEED_85_CODE }) === 'archive_only');
check('Geotab 90 archive-only', geotabSpeedingPolicy({ name: 'Heavy Duty Max Speeding 90KM/H', signalCode: SPEED_90_CODE }) === 'archive_only');
check('Geotab Speeding drop', geotabSpeedingPolicy({ name: 'Speeding', signalCode: 'speeding' }) === 'drop');
check('Geotab Heavy Duty Road Speeding Rule drop', geotabSpeedingPolicy({ name: 'Heavy Duty Road Speeding Rule', signalCode: 'aP4bSb7nyIUOPJ7ihBm1Idg' }) === 'drop');
check('other definition allow', geotabSpeedingPolicy({ name: 'Harsh Braking', signalCode: 'harshBraking' }) === 'allow');
check('poller 85 is poller-owned', isPollerOwnedAlert({ name: 'Heavy Duty Max Speeding 85km/h', signalCode: SPEED_85_CODE }) === true);

console.log('[zone category]');
check('high-risk only', categoryOf({ is_high_risk: true }) === 'high_risk');
check('no-go only', categoryOf({ is_no_go: true }) === 'no_go');
check('no-stopping only', categoryOf({ is_no_stopping: true }) === 'no_stopping');
check('conflicting flags default to high-risk', categoryOf({ is_high_risk: true, is_no_go: true }) === 'high_risk');
check('explicit category wins', categoryOf({ zone_category: 'no_go', is_high_risk: true }) === 'no_go');
check('high-risk entry label', entryLabel('high_risk').text === 'High Risk Area');
check('no-go entry label', entryLabel('no_go').text === 'No-Go Zone');
check('no-stopping entry label', entryLabel('no_stopping').text === 'No Stopping Zone');

console.log(`policy: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
