// Proves the reports tab can read an NCR that was saved from the alert modal,
// exactly as the UI does: create -> resolve -> read back BY INCIDENT ID.
// Self-cleaning.
process.env.DATABASE_URL = process.env.DATABASE_URL;

const db = require('./src/db');
const ncr = require('./src/services/ncrService');

const TAG = 'ncrread';

(async () => {
  const fleet = (await db.query('SELECT fleet_number FROM fleet_vehicles LIMIT 1')).rows[0];
  const fl = fleet ? fleet.fleet_number : 'PB29';

  const g = await db.query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, fleet_number, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, source_type, severity)
     VALUES ($1,$2,$3,$4,'NCR Read Test','test',1,$5,NOW(),'video','high') RETURNING id, group_key`,
    [`${TAG}:${Date.now()}`, `${TAG}-dev`, `${TAG}-dev - TEST`, fl, `${TAG}-a1`]
  );
  const group = g.rows[0];
  await db.query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, source_type, alert_group_id)
     VALUES ($1,$2,$3,'NCR Read Test',NOW(),'video',$4)`,
    [`${TAG}-a1`, `${TAG}-dev`, `${TAG}-dev - TEST`, group.id]
  );

  // 1. Save an NCR the way the alert modal does.
  const saved = await ncr.createNcrFromAlert({
    groupId: group.id,
    form: {
      ncrNo: TAG + '-1',
      driverName: 'Test Driver',
      department: 'Ops',
      vehicleFleetNumber: fl,
      alertType: 'NCR Read Test',
      alertId: String(group.id),
      description: 'Read-back probe',
      correctiveAction: '',
      outcome: '',
      correctiveResponsibility: 'admin@srs.co.za',
      correctiveTargetDate: null,
      classifications: ['Injury'],
      riskRating: 'high',
      notes: 'read probe',
    },
    evidence: [{ url: 'https://example.test/a.jpg', type: 'image', channel: 1, alertId: TAG + '-a1', capturedAt: null }],
    actor: { email: 'admin@srs.co.za', id: 'test-user' },
    archive: false,
  });

  const incidentId = saved && saved.incidentId;
  console.log('save ok           :', saved && saved.ok, '| error:', saved && saved.error);
  console.log('saved incident id  :', incidentId);
  if (!incidentId) { console.log('NO INCIDENT — cannot continue'); await db.closePool(); process.exit(1); }

  // 2. Read it back the way the reports tab does.
  const read = await ncr.getNcrFormByIncident(incidentId);
  console.log('read back by incident:', read ? 'FOUND' : 'NULL  <-- reports tab would show "no document"');
  if (read) {
    console.log('  ncr_no            :', read.ncr_no);
    console.log('  status            :', read.status);
    console.log('  evidence rows     :', (read.evidence || []).length);
    console.log('  created_by_email  :', read.created_by_email);
    console.log('  form_data keys    :', Object.keys(read.form_data || {}).length);
    console.log('  outcome (blank ok):', JSON.stringify(read.form_data?.outcome));
    console.log('  correctiveAction (blank ok):', JSON.stringify(read.form_data?.correctiveAction));
  }

  // 3. Simulate the fallback path: an NCR NOT linked by incident_id.
  await db.query('UPDATE ncr_forms SET incident_id = NULL WHERE id = $1', [saved.ncrFormId]);
  const viaGroup = await ncr.getNcrFormByIncident(incidentId);
  console.log('read back via alert-group fallback:', viaGroup ? 'FOUND (fallback works)' : 'NULL');

  await db.query('DELETE FROM ncr_evidence WHERE alert_id LIKE $1', [`${TAG}-%`]);
  await db.query('DELETE FROM ncr_forms WHERE ncr_no LIKE $1', [`${TAG}%`]);
  await db.query('DELETE FROM incidents WHERE incident_no LIKE $1', [`${TAG}%`]);
  await db.query('DELETE FROM alerts WHERE id LIKE $1', [`${TAG}-%`]);
  await db.query('DELETE FROM alert_groups WHERE group_key LIKE $1', [`${TAG}%`]);

  const ok = !!read && !!viaGroup;
  console.log(ok ? '\nNCR-READ-OK' : '\nNCR-READ-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });