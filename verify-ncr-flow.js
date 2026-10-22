// Local E2E for the new NCR flow:
//  1. POST /ncr stores the document fast + queues the work
//  2. the job runner closes the alert group (+ members)
//  3. the email job queues the escalation email
//  4. a collision alert queues a footage capture
process.env.DATABASE_URL = 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';
const db = require('./src/db');
const ncrService = require('./src/services/ncrService');
const jobRunner = require('./src/services/jobRunner');
const { isFootageAlarmType } = require('./src/services/alertFootageService');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

(async () => {
  await db.initializeDatabase();

  // Clean slate
  await db.query("DELETE FROM jobs WHERE job_type IN ('resolve','email','footage')");
  await db.query("DELETE FROM ncr_forms WHERE ncr_no LIKE 'NCR-TEST-%'");
  await db.query("DELETE FROM incidents WHERE incident_no LIKE 'NCR-TEST-%'");
  await db.query("DELETE FROM alert_groups WHERE group_key LIKE 'ncrtest%'");
  await db.query("DELETE FROM alerts WHERE id LIKE 'ncrtest-%'");

  // A registered vehicle + an open group with a member detection
  const veh = await db.query("SELECT fleet_number, registration_number FROM fleet_vehicles LIMIT 1");
  const fleet = veh.rows[0]?.fleet_number || 'PB29';
  const reg = veh.rows[0]?.registration_number || 'TESTREG';
  await db.query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, make, model, cost_center)
     VALUES ($1, $2, 'Test', 'Test', 'QA') ON CONFLICT (fleet_number, registration_number) DO NOTHING`,
    [fleet, reg]
  );
  const g = await db.query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, fleet_number, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, source_type, severity)
     VALUES ('ncrtest:g1', 'ncrtest-dev', $1, $2, 'Lane Deviation', 'test', 1, 'ncrtest-a1', NOW(), 'telematics', 'critical') RETURNING id`,
    [`ncrtest-dev - ${reg}`, fleet]
  );
  const gid = g.rows[0].id;
  await db.query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, source_type, alert_group_id, speed)
     VALUES ('ncrtest-a1', 'ncrtest-dev', $1, 'Lane Deviation', NOW(), 'telematics', $2, 80)`,
    [`ncrtest-dev - ${reg}`, gid]
  );

  // ── 1. Save the NCR (fast path) ───────────────────────────────────────
  const t0 = Date.now();
  const created = await ncrService.createNcrFromAlert({
    groupId: gid,
    userId: 'qa@test',
    form: {
      ncrNo: 'NCR-TEST-1',
      driverName: 'QA Driver',
      department: 'Express',
      section: 'Express',
      vehicleFleetNumber: fleet,
      vehicleRegistration: reg,
      date: '2026-10-21',
      time: '10:01',
      classifications: ['Lane Deviation'],
      description: 'QA description',
      correctiveAction: 'QA corrective',
      preventiveAction: 'QA preventive',
      riskRating: 'high',
      rootCauses: ['Unsafe Acts'],
      evidenceCount: 1,
    },
    evidence: [
      { url: 'https://example.test/a.jpg', type: 'image', channel: 1, alertId: 'ncrtest-a1', capturedAt: new Date().toISOString() },
    ],
  });
  const saveMs = Date.now() - t0;
  check(created.ok, `NCR created (${saveMs}ms)`);
  check(saveMs < 2000, `save is fast (${saveMs}ms)`);
  check(!!created.ncrFormId, `ncr_form id ${created.ncrFormId}`);
  check(!!created.incidentId, `incident id ${created.incidentId}`);

  const form = await ncrService.getNcrForm(created.ncrFormId);
  check(!!form, 'form readable');
  check(form.form_data.ncrNo === 'NCR-TEST-1', 'form_data keeps the document fields');
  check(form.form_data.correctiveAction === 'QA corrective', 'corrective action stored');
  check(form.evidence.length === 1, `evidence stored (${form.evidence.length})`);
  check(form.status === 'SAVED', `form status ${form.status}`);

  const jobs = await db.query("SELECT job_type, status FROM jobs WHERE ncr_form_id = $1", [created.ncrFormId]);
  check(jobs.rows.length >= 1, `resolve job queued (${jobs.rows.map((r) => r.job_type).join(',')})`);

  // ── 2. The runner closes the group (+ its members) ─────────────────────
  const groupBefore = await db.query('SELECT resolved FROM alert_groups WHERE id = $1', [gid]);
  check(groupBefore.rows[0].resolved === false, 'group still open before the runner');
  await jobRunner.tick();
  const groupAfter = await db.query('SELECT resolved, resolved_by FROM alert_groups WHERE id = $1', [gid]);
  check(groupAfter.rows[0].resolved === true, 'group closed by the background job');
  const member = await db.query('SELECT resolved, resolved_by FROM alerts WHERE id = $1', ['ncrtest-a1']);
  check(member.rows[0].resolved === true, 'member detection closed too');
  const inc = await db.query('SELECT status, closure_type FROM incidents WHERE id = $1', [created.incidentId]);
  check(String(inc.rows[0].status).toUpperCase() === 'RESOLVED', `incident status ${inc.rows[0].status}`);
  check(inc.rows[0].closure_type === 'ncr', `closure type ${inc.rows[0].closure_type}`);
  const formAfter = await ncrService.getNcrForm(created.ncrFormId);
  check(formAfter.status === 'RESOLVED', `form status after the job: ${formAfter.status}`);

  // ── 3. Email job queues the escalation email ─────────────────────────
  // Needs a real escalation group for the vehicle's cost centre.
  const { fetchVehiclesFromSupabase } = require('./src/helpers/supabaseClient');
  const sbVehicles = await fetchVehiclesFromSupabase();
  const sbRow = (sbVehicles || []).find((v) => String(v?.fleet_number || '').trim().toUpperCase() === String(fleet).trim().toUpperCase())
    || (sbVehicles || [])[0];
  const sbCcId = Number(sbRow?.cost_center_id || 0);
  let groupId = null;
  if (sbCcId > 0) {
    const ins = await db.query(
      `INSERT INTO escalation_groups (name, cost_center_id, ncr_cost_center_ids, is_active)
       VALUES ('QA Test Group', $1, $2::int[], TRUE) RETURNING id`,
      [sbCcId, [sbCcId]]
    );
    groupId = ins.rows[0].id;
    await db.query(
      `INSERT INTO escalation_group_members (escalation_group_id, email, name, is_active)
       VALUES ($1, 'qa-escalation@example.test', 'QA Escalation', TRUE)`,
      [groupId]
    );
  }
  const emailJob = await db.query(
    `INSERT INTO jobs (job_type, payload, ncr_form_id, incident_id, alert_group_id)
     VALUES ('email', $1::jsonb, $2, $3, $4) RETURNING id`,
    [JSON.stringify({ form: { ncrNo: 'NCR-TEST-1', vehicleFleetNumber: fleet, vehicleRegistration: reg } }), created.ncrFormId, created.incidentId, gid]
  );
  const outboxBefore = await db.query('SELECT count(*)::int c FROM ncr_email_outbox');
  await jobRunner.tick();
  const outboxAfter = await db.query('SELECT count(*)::int c FROM ncr_email_outbox');
  if (groupId) {
    check(outboxAfter.rows[0].c > outboxBefore.rows[0].c, `email queued in the outbox (${outboxBefore.rows[0].c} -> ${outboxAfter.rows[0].c})`);
  } else {
    console.log('SKIP email outbox check (no Supabase cost centre resolved for the test vehicle)');
  }
  await db.query('DELETE FROM jobs WHERE id = $1', [emailJob.rows[0].id]);
  if (groupId) {
    await db.query('DELETE FROM escalation_group_members WHERE escalation_group_id = $1', [groupId]);
    await db.query('DELETE FROM escalation_groups WHERE id = $1', [groupId]);
  }

  // ── 4. Collision alerts queue a footage capture ───────────────────────
  check(isFootageAlarmType('Possible Collision'), 'Possible Collision triggers footage');
  check(isFootageAlarmType('Possible collision'), 'Possible collision (lowercase c) triggers footage');
  check(isFootageAlarmType('Possible Collision (Legacy)'), 'Possible Collision (Legacy) triggers footage');
  check(isFootageAlarmType('Major Collision'), 'Major Collision triggers footage');
  check(isFootageAlarmType('Minor Collision'), 'Minor Collision triggers footage');
  check(isFootageAlarmType('Forward Collision'), 'Forward Collision triggers footage');
  check(!isFootageAlarmType('Lane Deviation'), 'other types do NOT trigger footage');
  check(!isFootageAlarmType('Camera Detected Possible Collision'), 'unrelated collision type excluded');

  const collision = await db.query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, fleet_number, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, source_type, severity)
     VALUES ('ncrtest:col', 'ncrtest-dev2', $1, $2, 'Major Collision', 'boom', 1, 'ncrtest-a2', NOW(), 'telematics', 'critical') RETURNING id`,
    [`ncrtest-dev2 - ${reg}`, fleet]
  );
  const alertGroups = require('./src/db/alert_groups');
  const created2 = await alertGroups.upsertAlertGroup({
    deviceId: 'ncrtest-dev3',
    deviceName: `ncrtest-dev3 - ${reg}`,
    alarmType: 'Major Collision',
    alarmText: 'boom',
    alertId: 'ncrtest-a3',
    alarmTs: new Date().toISOString(),
    lat: 0, lon: 0, speed: 0, sourceType: 'telematics', severity: 'critical',
  });
  check(!!created2, 'collision group created');
  const footageJobs = await db.query("SELECT id, payload FROM jobs WHERE job_type = 'footage'");
  check(footageJobs.rows.length >= 1, `footage job queued (${footageJobs.rows.length})`);
  if (footageJobs.rows.length) {
    const p = footageJobs.rows[0].payload || {};
    check(!!p.alertTime, 'footage job carries the alert time');
    check(p.alarmType === 'Major Collision', `footage job type ${p.alarmType}`);
  }

  // Cleanup
  await db.query("DELETE FROM jobs WHERE job_type IN ('resolve','email','footage')");
  await db.query("DELETE FROM ncr_evidence WHERE ncr_form_id IN (SELECT id FROM ncr_forms WHERE ncr_no LIKE 'NCR-TEST-%')");
  await db.query("DELETE FROM ncr_forms WHERE ncr_no LIKE 'NCR-TEST-%'");
  await db.query("DELETE FROM incidents WHERE incident_no LIKE 'NCR-TEST-%'");
  await db.query("DELETE FROM alert_groups WHERE group_key LIKE 'ncrtest%'");
  await db.query("DELETE FROM alerts WHERE id LIKE 'ncrtest-%'");
  await db.query("DELETE FROM fleet_vehicles WHERE fleet_number = $1 AND registration_number = $2", [fleet, reg]);

  console.log(ok ? 'NCR-FLOW-OK' : 'NCR-FLOW-FAIL');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('VERIFY-FAIL', e.message, e.stack); process.exit(1); });
