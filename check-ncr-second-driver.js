'use strict';
// Local-only check: the NCR save must persist the free-text driver name and
// the second driver through the ALERT_FORM_KEYS whitelist unchanged.
const ncrService = require('./src/services/ncrService');
const { query } = require('./src/db/pool');

(async () => {
  const g = await query('SELECT id FROM alert_groups ORDER BY id DESC LIMIT 1');
  const groupId = g.rows[0]?.id;
  if (!groupId) { console.log('FAIL no alert group in local DB'); process.exit(1); }

  const ncrNo = `NCR-TEST-2ND-${Date.now()}`;
  const res = await ncrService.createNcrFromAlert({
    groupId,
    form: {
      ncrNo,
      driverName: 'Johan Freeform',          // free text, not a registered driver
      driverId: null,
      secondDriverId: null,
      secondDriverName: 'Pieter Van Der Merwe',
      department: 'Fleet Operations',
      vehicleFleetNumber: 'EX63',
      classifications: ['Speeding Violation'],
      description: 'test',
    },
    evidence: [],
    actor: { id: 'test-actor', email: 'tester@srs.local' },
  });
  if (!res.ok) { console.log('FAIL save:', res); process.exit(1); }

  const row = await query('SELECT form_data FROM ncr_forms WHERE id = $1', [res.ncrFormId]);
  const fd = row.rows[0]?.form_data || {};
  const checks = [
    ['driverName free text persisted', fd.driverName === 'Johan Freeform'],
    ['secondDriverName persisted', fd.secondDriverName === 'Pieter Van Der Merwe'],
    ['secondDriverId null persisted', fd.secondDriverId === null],
    ['legacy keys untouched (ncrNo)', fd.ncrNo === ncrNo],
    ['legacy keys untouched (driverId)', fd.driverId === null],
    ['legacy keys untouched (classifications)', JSON.stringify(fd.classifications) === JSON.stringify(['Speeding Violation'])],
  ];
  let fail = 0;
  for (const [label, ok] of checks) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label);
    if (!ok) fail++;
  }

  // cleanup test rows (local DB only)
  await query('DELETE FROM ncr_evidence WHERE ncr_form_id = $1', [res.ncrFormId]).catch(() => {});
  await query('DELETE FROM ncr_forms WHERE id = $1', [res.ncrFormId]).catch(() => {});
  if (res.incidentId) await query('DELETE FROM incidents WHERE id = $1', [res.incidentId]).catch(() => {});

  console.log(fail === 0 ? 'ncr-second-driver: OK' : `ncr-second-driver: ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
