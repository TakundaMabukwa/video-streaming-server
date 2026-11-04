'use strict';
// Local-only E2E for the NCR form-integrity batch:
//  - verbatim storage (no group fallbacks)
//  - closure job never re-writes form fields (stale-overwrite race)
//  - PATCH /incidents/:id mirrors into ncr_forms.form_data
//  - NULL-cc incidents with an NCR stay visible under a cc filter
//  - incident_no unique constraint gone
//
// Run:  docker compose cp test-ncr-integrity.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-ncr-integrity.js

const { query } = require('./src/db/pool');
const db = require('./src/db');
const ncrService = require('./src/services/ncrService');
const { closeAlertGroup } = require('./src/services/alertClosureService');
const incidentsRoutes = require('./src/routes/incidentsRoutes');

const DEVICE_ID = 'TESTNCR01';
const FLEET = 'LH29';
const REG = 'LDG368MP';
const DEVICE_NAME = `${FLEET} - ${REG}`;
const GROUP_KEY = `${DEVICE_ID}:ncr integrity test`;
const ACTOR = { id: 'test-actor', email: 'ncr-test@srs.local' };

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

// Minimal Express-like mock for the PATCH route.
function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}
function patchHandler() {
  // The route file exports a router; grab the PATCH '/:id' stack handler.
  const layer = incidentsRoutes.stack.find(
    (l) => l.route && l.route.methods && l.route.methods.patch && Object.keys(l.route.methods).length === 1
  );
  if (!layer) throw new Error('PATCH route not found on incidents router');
  return layer.route.stack[0].handle;
}

(async () => {
  console.log('== prep: clean test device ==');
  // Target every row this test device could have left behind — including
  // incidents from earlier runs (real group keys differ per run's group).
  await query(
    `     DELETE FROM ncr_evidence WHERE ncr_form_id IN (
             SELECT id FROM ncr_forms WHERE incident_id IN (
               SELECT id FROM incidents WHERE device_id = $1 OR filled_by = $2))`,
    [DEVICE_ID, ACTOR.email]).catch(() => {});
  await query('DELETE FROM ncr_forms WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1 OR filled_by = $2)',
    [DEVICE_ID, ACTOR.email]).catch(() => {});
  await query('DELETE FROM incidents WHERE device_id = $1 OR filled_by = $2 OR alert_group_key = $3',
    [DEVICE_ID, ACTOR.email, GROUP_KEY]).catch(() => {});
  for (const sql of [
    'DELETE FROM alert_cooldown_members WHERE device_id = $1',
    'DELETE FROM alert_cooldown_groups WHERE device_id = $1',
    'DELETE FROM alert_cooldowns WHERE device_id = $1',
    'DELETE FROM alerts WHERE device_id = $1',
    'DELETE FROM alert_groups WHERE device_id = $1',
  ]) await query(sql, [DEVICE_ID]).catch(() => {});

  console.log('== [1] incident_no unique constraint is gone ==');
  const uq = await query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'incidents'::regclass AND contype = 'u'`
  );
  const uqNames = uq.rows.map((r) => r.conname);
  check('incidents_incident_no_key dropped', !uqNames.includes('incidents_incident_no_key'), uqNames.join(','));
  check('incidents_alert_id_key kept', uqNames.includes('incidents_alert_id_key'), uqNames.join(','));

  console.log('== [2] NCR save stores form verbatim (no group fallbacks) ==');
  const group = await db.upsertAlertGroup({
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    alarmType: 'Cellphone Use',
    alarmText: 'ncr integrity test',
    alertId: 'ncr-t-1',
    alarmTs: new Date().toISOString(),
    lat: -28.9, lon: 26.4, speed: 60,
    sourceType: 'video',
    severity: 'high',
    fleetNumber: FLEET,
    registration: REG,
  });
  check('fixture group created', !!(group && group.id), JSON.stringify(group));

  // Deliberately blank fleet + no classifications: nothing should be
  // substituted from the group.
  const saved = await ncrService.createNcrFromAlert({
    groupId: group.id,
    form: {
      ncrNo: 'NCR-TEST-001',
      driverName: 'Verbatim Driver',
      vehicleFleetNumber: '',       // blank on purpose
      vehicleRegistration: '',
      classifications: [],           // none ticked on purpose
      description: 'verbatim description',
    },
    evidence: [],
    actor: ACTOR,
    archive: false,
  });
  check('NCR saved', saved.ok === true, JSON.stringify(saved));

  const formRow = (await query('SELECT * FROM ncr_forms WHERE id = $1', [saved.ncrFormId])).rows[0];
  const fd = formRow.form_data;
  check('driverName stored verbatim', fd.driverName === 'Verbatim Driver', fd.driverName);
  check('blank fleet stays blank on document', fd.vehicleFleetNumber === '' || fd.vehicleFleetNumber == null, JSON.stringify(fd.vehicleFleetNumber));
  check('blank fleet stored on incident (no device_id fallback)',
    (await query('SELECT fleet_number FROM incidents WHERE id = $1', [saved.incidentId])).rows[0].fleet_number == null);
  check('blank classifications stored as empty (no alarm_type fallback)',
    (await query('SELECT infringement FROM incidents WHERE id = $1', [saved.incidentId])).rows[0].infringement == null);
  check('description verbatim on incident',
    (await query('SELECT infringement_detail FROM incidents WHERE id = $1', [saved.incidentId])).rows[0].infringement_detail === 'verbatim description');

  console.log('== [3] closure job writes closure fields only (stale-overwrite race) ==');
  // Re-save the NCR with NEW values while the first job is "still queued".
  const resaved = await ncrService.createNcrFromAlert({
    groupId: group.id,
    form: {
      ncrNo: 'NCR-TEST-001',
      driverName: 'Second Save Driver',
      vehicleFleetNumber: 'LH29',
      vehicleRegistration: 'LDG368MP',
      classifications: ['Speeding Violation'],
      description: 'second save description',
    },
    evidence: [],
    actor: ACTOR,
    archive: false,
  });
  check('re-save updated (not new)', resaved.ok === true && resaved.updated === true, JSON.stringify(resaved));

  // Now run the FIRST job's payload (stale driver/fleet) through closeAlertGroup.
  const closure = await closeAlertGroup({
    groupId: group.id,
    userId: ACTOR.email,
    notes: 'stale job notes',
    closureType: 'ncr',
    incident: {
      fleet_number: 'STALE-FLEET',
      driver_name: 'Stale Job Driver',
      contact_number: '0000000000',
      infringement: 'Stale Infringement',
      infringement_detail: 'stale detail',
    },
    incidentId: saved.incidentId,
  });
  check('closure job ok', closure.ok === true, JSON.stringify(closure?.error));

  const afterJob = (await query('SELECT * FROM incidents WHERE id = $1', [saved.incidentId])).rows[0];
  check('driver NOT overwritten by stale job', afterJob.driver_name === 'Second Save Driver', afterJob.driver_name);
  check('fleet NOT overwritten by stale job', afterJob.fleet_number === 'LH29', afterJob.fleet_number);
  check('infringement NOT overwritten by stale job', afterJob.infringement === 'Speeding Violation', afterJob.infringement);
  check('closure status applied', afterJob.status === 'RESOLVED', afterJob.status);
  check('closure_type applied', afterJob.closure_type === 'ncr', afterJob.closure_type);
  check('alert identity applied', afterJob.alarm_type === 'Cellphone Use' && (afterJob.device_id === DEVICE_ID || afterJob.device_id === FLEET), afterJob.device_id);

  console.log('== [4] PATCH mirrors register edits into ncr_forms.form_data ==');
  const patch = patchHandler();
  const res1 = mockRes();
  await patch(
    {
      params: { id: saved.incidentId },
      body: {
        driver_name: 'Edited Driver',
        contact_number: '0821234567',
        fleet_number: 'LH29',
        infringement: 'Reckless Driving, No Seatbelt',
        infringement_detail: 'edited description',
        outcome: 'Counselling',
      },
    },
    res1,
  );
  check('PATCH success', res1.body?.success === true, JSON.stringify(res1.body));

  const afterPatch = (await query('SELECT * FROM incidents WHERE id = $1', [saved.incidentId])).rows[0];
  check('incident driver edited', afterPatch.driver_name === 'Edited Driver', afterPatch.driver_name);
  check('incident contact edited', afterPatch.contact_number === '0821234567', afterPatch.contact_number);

  const formAfter = (await query('SELECT form_data FROM ncr_forms WHERE incident_id = $1', [saved.incidentId])).rows[0].form_data;
  check('document driverName mirrored', formAfter.driverName === 'Edited Driver', formAfter.driverName);
  check('document contactNumber mirrored', formAfter.contactNumber === '0821234567', formAfter.contactNumber);
  check('document description mirrored', formAfter.description === 'edited description', formAfter.description);
  check('document outcome mirrored', formAfter.outcome === 'Counselling', formAfter.outcome);
  check('document classifications mirrored from infringement',
    Array.isArray(formAfter.classifications) && formAfter.classifications.join('|') === 'Reckless Driving|No Seatbelt',
    JSON.stringify(formAfter.classifications));
  check('untouched document keys survive the shallow merge', formAfter.ncrNo === 'NCR-TEST-001', formAfter.ncrNo);

  console.log('== [5] NULL-cc NCR stays visible under a cost-centre filter ==');
  // The saved incident has cc resolved from LH29 (real fleet). Force NULL cc
  // to simulate an unresolvable fleet.
  await query('UPDATE incidents SET cost_center_id = NULL WHERE id = $1', [saved.incidentId]);
  const { getIncidents } = require('./src/db/incidents');
  const listed = await getIncidents({ cost_center_ids: '7,8,18', hasNcr: true, pageSize: 500, pageIndex: 1 });
  check('NULL-cc incident with NCR visible under cc filter',
    listed.incidents.some((i) => i.id === saved.incidentId),
    `total=${listed.total}`);
  // And without an NCR document a NULL-cc incident stays hidden.
  const orphan = await db.upsertIncidentFromAlert({
    alertId: 'ncr-orphan-1',
    alarmType: 'Cellphone Use',
    deviceId: DEVICE_ID,
    fleetNumber: null,
    costCenterId: null,
    filledBy: ACTOR.email,
    status: 'OPEN',
  });
  const listed2 = await getIncidents({ cost_center_ids: '7,8,18', hasNcr: true, pageSize: 500, pageIndex: 1 });
  check('NULL-cc incident WITHOUT NCR still hidden',
    !listed2.incidents.some((i) => i.id === orphan.id));

  console.log('== [6] deduction lookup may use group fleet, never stored ==');
  const g2 = await db.upsertAlertGroup({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME, alarmType: 'Harsh Braking',
    alarmText: 'deduct lookup', alertId: 'ncr-t-2',
    alarmTs: new Date().toISOString(), lat: -28.9, lon: 26.4, speed: 70,
    sourceType: 'video', severity: 'high', fleetNumber: FLEET, registration: REG,
  });
  const closure2 = await closeAlertGroup({
    groupId: g2.id,
    userId: ACTOR.email,
    closureType: 'ncr',
    incident: { fleet_number: '', driver_name: 'No Fleet Driver', infringement: '' },
  });
  check('close without fleet ok', closure2.ok === true, JSON.stringify(closure2?.error));
  const inc2 = (await query('SELECT * FROM incidents WHERE alert_group_key = $1', [g2.group_key])).rows[0];
  check('no fleet stored from group fallback', inc2.fleet_number == null, inc2.fleet_number);
  check('blank infringement stored as null', inc2.infringement == null, inc2.infringement);
  check('driver verbatim', inc2.driver_name === 'No Fleet Driver', inc2.driver_name);

  console.log('== cleanup ==');
  await query(
    `     DELETE FROM ncr_evidence WHERE ncr_form_id IN (
             SELECT id FROM ncr_forms WHERE incident_id IN (
               SELECT id FROM incidents WHERE device_id = $1 OR filled_by = $2))`,
    [DEVICE_ID, ACTOR.email]).catch(() => {});
  await query('DELETE FROM ncr_forms WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1 OR filled_by = $2)',
    [DEVICE_ID, ACTOR.email]).catch(() => {});
  await query('DELETE FROM incidents WHERE device_id = $1 OR filled_by = $2',
    [DEVICE_ID, ACTOR.email]).catch(() => {});
  for (const sql of [
    'DELETE FROM alert_cooldown_members WHERE device_id = $1',
    'DELETE FROM alert_cooldown_groups WHERE device_id = $1',
    'DELETE FROM alert_cooldowns WHERE device_id = $1',
    'DELETE FROM alerts WHERE device_id = $1',
    'DELETE FROM alert_groups WHERE device_id = $1',
  ]) await query(sql, [DEVICE_ID]).catch(() => {});

  console.log(`ncr-integrity: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
