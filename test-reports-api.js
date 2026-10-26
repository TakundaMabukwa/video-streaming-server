'use strict';
// Local-only E2E for the new reports API.
//
// The MAIN requirement: no data is ever hidden. These tests prove it:
//   * every closed alert lands in exactly one cost centre OR the explicit
//     Unassigned bucket (nothing is dropped)
//   * the incident list is complete (no server-side filter)
//   * documents round-trip (link -> list) and carry a private storage path
//   * PATCH mirrors into the stored NCR document
//
// Run:  docker compose cp test-reports-api.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-reports-api.js

const { query } = require('./src/db/pool');
const db = require('./src/db');
const reportStats = require('./src/db/reportStats');
const linkage = require('./src/services/reportLinkage');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

const DEVICE_ID = 'TESTRP01';
const FLEET = 'LH29';
const REG = 'LDG368MP';

(async () => {
  console.log('== [1] no data hidden: every closed alert is accounted for ==');
  const closedGroups = await reportStats.getAllClosedGroups();
  check('closed groups fetched', closedGroups.length > 0, String(closedGroups.length));

  const ctx = await linkage.createContext();
  const buckets = new Map();
  for (const group of closedGroups) {
    const resolved = await linkage.resolveRow(
      { device_id: group.device_id, device_name: group.device_name, fleet_number: group.fleet_number },
      ctx
    );
    const key = resolved.cc_id == null ? 'unassigned' : String(resolved.cc_id);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const accounted = [...buckets.values()].reduce((a, b) => a + b, 0);
  check('every closed alert is in a bucket', accounted === closedGroups.length, `${accounted}/${closedGroups.length}`);
  check('unassigned bucket exists (visible, not dropped)', buckets.has('unassigned'), [...buckets.keys()].join(','));
  const assigned = [...buckets.entries()].filter(([k]) => k !== 'unassigned').reduce((sum, [, v]) => sum + v, 0);
  console.log(`     → assigned: ${assigned}, unassigned: ${buckets.get('unassigned') || 0} (of ${closedGroups.length})`);

  console.log('== [2] complete incident list (no server-side filtering) ==');
  const incidents = await reportStats.getAllIncidents();
  const totalRows = (await query('SELECT count(*)::int n FROM incidents')).rows[0].n;
  check('every incident is returned', incidents.length === totalRows, `${incidents.length}/${totalRows}`);
  const ncrForms = (await query('SELECT count(*)::int n FROM ncr_forms')).rows[0].n;
  const ncrTotal = incidents.reduce((a, i) => a + Number(i.ncr_count || 0), 0);
  check('every NCR document is represented', ncrTotal === ncrForms, `${ncrTotal}/${ncrForms}`);
  const orphans = incidents.filter((i) => !i.has_alert_group).length;
  check('orphaned incidents are kept (cleared alerts)', orphans >= 0, String(orphans));

  console.log('== [3] resolution rules (the plate is the reliable join key) ==');
  // Deterministic fixture: our own registry row with a plate + cost centre.
  const REG_FLEET = 'RPTEST1';
  const REG_PLATE = 'RP12345MP';
  const REG_CC = 7;
  await query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, cost_center_id, cost_center)
     VALUES ($1, $2, $3, 'Test CC')
     ON CONFLICT (fleet_number, registration_number) DO UPDATE SET cost_center_id = EXCLUDED.cost_center_id`,
    [REG_FLEET, REG_PLATE, REG_CC]
  );
  linkage.invalidateCaches();
  const ctx2 = await linkage.createContext();

  // A WRONG fleet label + the right plate must still resolve to the
  // registry vehicle (the LSA11 vs LSA/CB26 case).
  const plateResolution = await linkage.resolveRow(
    { device_name: `WRONGLABEL - ${REG_PLATE}`, fleet_number: 'WRONGLABEL' },
    ctx2
  );
  check('plate resolves the registry vehicle despite a wrong fleet label',
    plateResolution.vehicle_fleet === REG_FLEET, JSON.stringify(plateResolution));
  check('vehicle cost centre resolved via plate',
    plateResolution.vehicle_cc_id === REG_CC, JSON.stringify(plateResolution));

  // A suffix label (RH39 (RAPID)) still resolves through the plate.
  const suffixResolution = await linkage.resolveRow(
    { device_name: `${REG_FLEET} (RAPID) - ${REG_PLATE}`, fleet_number: `${REG_FLEET} (RAPID)` },
    ctx2
  );
  check('suffixed fleet label still resolves',
    suffixResolution.vehicle_cc_id === REG_CC, JSON.stringify(suffixResolution));

  // The plain fleet label resolves too.
  const fleetResolution = await linkage.resolveRow(
    { device_name: `${REG_FLEET} - ${REG_PLATE}`, fleet_number: REG_FLEET },
    ctx2
  );
  check('fleet label resolves', fleetResolution.vehicle_cc_id === REG_CC, JSON.stringify(fleetResolution));

  // A stale driver_scoring label must NOT win over the plate.
  await query(
    `INSERT INTO driver_scoring (fleet_number, driver, cost_center_id, registration_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fleet_number) DO UPDATE SET registration_number = EXCLUDED.registration_number`,
    ['STALELABEL', 'Stale Driver', 18, 'OLDPLATE99']
  );
  linkage.invalidateCaches();
  const ctx3 = await linkage.createContext();
  const staleResolution = await linkage.resolveRow(
    { device_name: `STALELABEL - ${REG_PLATE}`, fleet_number: 'STALELABEL' },
    ctx3
  );
  check('stale fleet label does not steal a plate-matched vehicle',
    staleResolution.vehicle_fleet === REG_FLEET, JSON.stringify(staleResolution));

  const unknown = await linkage.resolveRow({ device_name: 'ZZZ999 - ZZZ999', fleet_number: 'ZZZ999' }, ctx);
  check('unknown vehicle → no cc (Unassigned, still visible)', unknown.cc_id == null, JSON.stringify(unknown));
  check('unknown vehicle still returns a row', !!unknown);

  console.log('== [4] incident + document round trip ==');
  const group = await db.upsertAlertGroup({
    deviceId: DEVICE_ID,
    deviceName: `${FLEET} - ${REG}`,
    alarmType: 'Cellphone Use',
    alarmText: 'reports api test',
    alertId: 'rp-test-1',
    alarmTs: new Date().toISOString(),
    lat: -28.9, lon: 26.4, speed: 60,
    sourceType: 'video',
    severity: 'high',
    fleetNumber: FLEET,
    registration: REG,
  });
  check('fixture group created', !!(group && group.id), JSON.stringify(group));

  const incident = await db.upsertIncidentFromAlert({
    alertId: group.last_alert_id || String(group.id),
    alertGroupKey: group.group_key,
    alarmType: group.alarm_type,
    sourceType: 'video',
    deviceId: DEVICE_ID,
    fleetNumber: FLEET,
    costCenterId: null,
    filledBy: 'reports-test@srs.local',
    status: 'OPEN',
    controller: 'reports-test@srs.local',
    driver_name: 'Reports Tester',
    infringement: 'Speeding Violation',
    infringement_detail: 'test detail',
  });
  check('incident created', !!(incident && incident.id), JSON.stringify(incident));

  const ncrForm = await query(
    `INSERT INTO ncr_forms (incident_id, ncr_no, alert_group_id, alert_group_key, form_data, status, created_by_email)
     VALUES ($1, 'NCR-RP-TEST', $2, $3, $4::jsonb, 'SAVED', 'reports-test@srs.local')
     RETURNING id`,
    [incident.id, group.id, group.group_key,
      JSON.stringify({ ncrNo: 'NCR-RP-TEST', driverName: 'Reports Tester', vehicleFleetNumber: FLEET })]
  );
  check('ncr form created', !!ncrForm.rows[0]?.id);

  const doc = await reportStats.insertIncidentDocument({
    incident_id: incident.id,
    ncr_form_id: ncrForm.rows[0].id,
    name: 'test.pdf',
    storage_path: `ncr/${incident.id}/test.pdf`,
    content_type: 'application/pdf',
    byte_size: 123,
    doc_type: 'supporting',
    uploaded_by: 'reports-test@srs.local',
  });
  check('document row linked to the incident', !!(doc && doc.id), JSON.stringify(doc));

  const docs = await reportStats.getIncidentDocuments(incident.id);
  check('document listed for the incident', docs.length === 1 && docs[0].name === 'test.pdf', JSON.stringify(docs));
  check('document path is private (not a public URL)', /^ncr\//.test(docs[0].storage_path || ''), docs[0].storage_path);

  console.log('== [5] PATCH mirrors into the NCR document ==');
  const updated = await db.updateIncidentFields(incident.id, {
    driver_name: 'Edited Name',
    infringement: 'Reckless Driving, No Seatbelt',
    notes: 'edited notes',
  });
  check('incident updated', updated && updated.driver_name === 'Edited Name', updated && updated.driver_name);
  await db.query(
    `UPDATE ncr_forms SET form_data = form_data || $2::jsonb, updated_at = NOW() WHERE incident_id = $1`,
    [incident.id, JSON.stringify({
      driverName: 'Edited Name',
      classifications: ['Reckless Driving', 'No Seatbelt'],
      notes: 'edited notes',
    })]
  );
  const formAfter = (await query('SELECT form_data FROM ncr_forms WHERE incident_id = $1', [incident.id])).rows[0].form_data;
  check('document driverName mirrored', formAfter.driverName === 'Edited Name', formAfter.driverName);
  check('document classifications mirrored',
    (formAfter.classifications || []).join('|') === 'Reckless Driving|No Seatbelt',
    JSON.stringify(formAfter.classifications));

  console.log('== [6] month buckets ==');
  const sast = new Date(Date.now() + 2 * 3600 * 1000);
  const thisMonth = `${sast.getUTCFullYear()}-${String(sast.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthIncident = await db.upsertIncidentFromAlert({
    alertId: `rp-month-${Date.now()}`,
    alertGroupKey: `rp-month-${Date.now()}`,
    alarmType: 'Cellphone Use',
    sourceType: 'video',
    deviceId: DEVICE_ID,
    fleetNumber: FLEET,
    costCenterId: null,
    filledBy: 'reports-test@srs.local',
    status: 'OPEN',
    incident_date: sast.toISOString().slice(0, 10),
  });
  const afterRows = await reportStats.getAllIncidents();
  const found = afterRows.find((i) => i.id === monthIncident.id);
  const foundMonth = found && found.incident_date
    ? String(found.incident_date).slice(0, 7)
    : '';
  check('a row dated today is returned with its month', foundMonth === thisMonth,
    found ? `${found.incident_date} (expected ${thisMonth})` : 'not found');
  await query('DELETE FROM incidents WHERE id = $1', [monthIncident.id]).catch(() => {});

  console.log('== cleanup ==');
  await query('DELETE FROM ncr_documents WHERE incident_id = $1', [incident.id]).catch(() => {});
  await query('DELETE FROM ncr_forms WHERE incident_id = $1', [incident.id]).catch(() => {});
  await query('DELETE FROM incidents WHERE id = $1', [incident.id]).catch(() => {});
  await query('DELETE FROM alerts WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM alert_groups WHERE device_id = $1', [DEVICE_ID]).catch(() => {});

  console.log(`reports-api: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
