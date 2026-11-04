process.env.DATABASE_URL = process.env.DATABASE_URL;
const ncr = require('/app/src/services/ncrService');
const db = require('/app/src/db');

const INCIDENT_ID = process.argv[2];

(async () => {
  const form = await ncr.getNcrFormByIncident(INCIDENT_ID);
  console.log('service getNcrFormByIncident ->',
    form
      ? 'FOUND id=' + form.id + ' ncr_no=' + form.ncr_no + ' status=' + form.status +
        ' evidence=' + ((form.evidence || []).length)
      : 'NULL  <-- this is what the reports tab receives');

  const raw = await db.query(
    'SELECT id, incident_id, alert_group_id, ncr_no, status, created_by_email FROM ncr_forms WHERE incident_id = $1',
    [INCIDENT_ID]
  );
  console.log('raw ncr_forms row:', JSON.stringify(raw.rows[0] || null));

  if (form) {
    const fd = form.form_data || {};
    console.log('form_data keys:', Object.keys(fd).length);
    console.log('  ncrNo:', fd.ncrNo, '| alertType:', fd.alertType);
    console.log('  correctiveAction:', JSON.stringify(String(fd.correctiveAction || '').slice(0, 50)));
    console.log('  outcome:', JSON.stringify(String(fd.outcome || '').slice(0, 50)));
    console.log('  correctiveResponsibility:', fd.correctiveResponsibility);
    console.log('  correctiveTargetDate:', fd.correctiveTargetDate);
    console.log('  attachments:', (fd.attachments || []).length);
  }

  // How many incident rows can find a form at all?
  const stats = await db.query(
    `SELECT
       (SELECT count(*) FROM incidents) AS incidents,
       (SELECT count(*) FROM ncr_forms) AS forms,
       (SELECT count(*) FROM ncr_forms WHERE incident_id IS NOT NULL) AS forms_with_incident,
       (SELECT count(*) FROM incidents i WHERE EXISTS (
          SELECT 1 FROM ncr_forms nf WHERE nf.incident_id = i.id)) AS incidents_with_form`
  );
  console.log('rollup:', JSON.stringify(stats.rows[0]));

  await db.closePool();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });