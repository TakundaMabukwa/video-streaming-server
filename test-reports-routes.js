'use strict';
// Local-only E2E for the reports ROUTES (the contract the frontend uses).
//
// The core invariant: the numbers the UI shows must add up to the whole
// dataset. Nothing may be dropped on the way to a cost centre.
//
// Run:  docker compose cp test-reports-routes.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-reports-routes.js

const { query } = require('./src/db/pool');
const db = require('./src/db');
const reportRoutes = require('./src/routes/reportRoutes');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

function mockRes() {
  const res = {
    statusCode: 200, body: null, headers: {},
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
    setHeader(k, v) { res.headers[k] = v; },
  };
  return res;
}

function handler(method, path) {
  const layer = reportRoutes.stack.find(
    (l) => l.route && l.route.methods && l.route.methods[method]
      && l.route.path === path
  );
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

async function call(method, path, { params = {}, query = {}, body = {}, user = { email: 'reports-test@srs.local' } } = {}) {
  const res = mockRes();
  await handler(method, path)({ params, query, body, user, headers: {}, cookies: {} }, res);
  return res;
}

(async () => {
  console.log('== [1] GET /reports/incidents — the complete dataset ==');
  const resInc = await call('get', '/incidents');
  check('200', resInc.statusCode === 200, JSON.stringify(resInc.body).slice(0, 200));
  const body = resInc.body || {};
  check('success flag', body.success === true);
  check('incidents returned', Array.isArray(body.incidents) && body.incidents.length > 0, String(body.incidents?.length));
  check('closed alerts returned', Array.isArray(body.closed_alerts) && body.closed_alerts.length > 0, String(body.closed_alerts?.length));
  check('cost centres returned', Array.isArray(body.cost_centers) && body.cost_centers.length > 0, String(body.cost_centers?.length));
  check('month buckets returned', !!(body.months && body.months.thisMonth && body.months.lastMonth), JSON.stringify(body.months));

  const dbIncidents = (await query('SELECT count(*)::int n FROM incidents')).rows[0].n;
  check('NO incident is filtered out server-side', body.incidents.length === dbIncidents, `${body.incidents?.length}/${dbIncidents}`);
  const dbClosed = (await query('SELECT count(*)::int n FROM alert_groups WHERE resolved=TRUE AND false_alert=FALSE')).rows[0].n;
  check('NO closed alert is filtered out server-side', body.closed_alerts.length === dbClosed, `${body.closed_alerts?.length}/${dbClosed}`);

  console.log('== [2] every row carries its linkage fields ==');
  const sample = body.incidents[0] || {};
  for (const field of ['id', 'incident_no', 'status', 'has_ncr', 'ncr_count', 'doc_count', 'vehicle_cc_id', 'driver_cc_id', 'cc_id', 'driver_name', 'driver_key']) {
    check(`row has "${field}"`, field in sample, Object.keys(sample).join(','));
  }
  const withDriver = body.incidents.filter((i) => i.driver_name).length;
  console.log(`     → ${withDriver}/${body.incidents.length} incidents have a resolved driver name`);

  console.log('== [3] GET /reports/cost-centre-stats — nothing lost ==');
  const resStats = await call('get', '/cost-centre-stats');
  check('200', resStats.statusCode === 200);
  const stats = resStats.body?.stats || [];
  check('stats rows returned', stats.length > 0, String(stats.length));
  check('an Unassigned bucket exists', stats.some((s) => s.cc_id === null), JSON.stringify(stats.map((s) => s.cc_name)));
  const sumAlerts = stats.reduce((a, s) => a + Number(s.alerts_total || 0), 0);
  const sumEvents = stats.reduce((a, s) => a + Number(s.alert_events_total || 0), 0);
  const sumNcrs = stats.reduce((a, s) => a + Number(s.ncrs_total || 0), 0);
  const dbClosedAlerts = (await query(
    `SELECT count(*)::int n FROM alert_groups WHERE resolved=TRUE AND false_alert=FALSE`
  )).rows[0].n;
  const dbClosedEvents = (await query(
    `SELECT COALESCE(SUM(count),0)::int n FROM alert_groups WHERE resolved=TRUE AND false_alert=FALSE`
  )).rows[0].n;
  const dbNcrs = (await query('SELECT count(*)::int n FROM ncr_forms')).rows[0].n;
  check('closed alerts across the cards == every closed alert', sumAlerts === dbClosedAlerts, `${sumAlerts}/${dbClosedAlerts}`);
  check('alert events across the cards == every detection', sumEvents === dbClosedEvents, `${sumEvents}/${dbClosedEvents}`);
  check('NCRs across the cards == every NCR document', sumNcrs === dbNcrs, `${sumNcrs}/${dbNcrs}`);
  const card = stats[0] || {};
  for (const field of ['cc_id', 'cc_name', 'alerts_this_month', 'alerts_last_month', 'ncrs_this_month', 'ncrs_last_month', 'alerts_total', 'ncrs_total']) {
    check(`card has "${field}"`, field in card, Object.keys(card).join(','));
  }

  console.log('== [4] GET /reports/cost-centre/:id/rows — drill-down ==');
  const someCc = stats.find((s) => s.cc_id !== null);
  if (someCc) {
    const resRows = await call('get', '/cost-centre/:ccId/rows', { params: { ccId: String(someCc.cc_id) } });
    check('200', resRows.statusCode === 200, JSON.stringify(resRows.body).slice(0, 200));
    check('closed alerts listed', Array.isArray(resRows.body?.closed_alerts));
    check('incidents listed', Array.isArray(resRows.body?.incidents));
  } else {
    const resRows = await call('get', '/cost-centre/:ccId/rows', { params: { ccId: 'unassigned' } });
    check('unassigned drill-down works', resRows.statusCode === 200);
    check('closed alerts listed', Array.isArray(resRows.body?.closed_alerts));
  }

  console.log('== [5] GET /reports/driver-stats — only drivers with NCRs ==');
  const resDrivers = await call('get', '/driver-stats');
  check('200', resDrivers.statusCode === 200);
  const drivers = resDrivers.body?.drivers || [];
  check('drivers returned', Array.isArray(drivers), String(drivers.length));
  const sumDriverNcrs = drivers.reduce((a, d) => a + Number(d.ncrs_total || 0), 0);
  const dbNcrs2 = (await query('SELECT count(*)::int n FROM ncr_forms')).rows[0].n;
  check('every NCR belongs to a driver row', sumDriverNcrs === dbNcrs2, `${sumDriverNcrs}/${dbNcrs2}`);
  check('every driver row has at least one NCR', drivers.every((d) => Number(d.ncrs_total || 0) > 0));
  const driverSample = drivers[0] || {};
  for (const field of ['driver_key', 'driver_name', 'ncrs_this_month', 'offences_this_month', 'ncrs']) {
    check(`driver row has "${field}"`, field in driverSample, Object.keys(driverSample).join(','));
  }

  console.log('== [6] documents: validation + list ==');
  const resBad = await call('post', '/incidents/:id/documents', { params: { id: 'not-an-id' }, body: {} });
  check('upload without a file → 400', resBad.statusCode === 400, String(resBad.statusCode));
  const resMissing = await call('post', '/incidents/:id/documents', { params: { id: '00000000-0000-0000-0000-000000000000' }, body: { file: { data: Buffer.from('x').toString('base64'), name: 'x.txt' } } });
  check('upload for an unknown incident → 404', resMissing.statusCode === 404, String(resMissing.statusCode));
  const resDocs = await call('get', '/incidents/:id/documents', { params: { id: '00000000-0000-0000-0000-000000000000' } });
  check('document list for an incident → 200 with an array', resDocs.statusCode === 200 && Array.isArray(resDocs.body?.documents));

  // A storage path from ANOTHER incident must be refused (needs a real id).
  const realIncident = (await query('SELECT id FROM incidents ORDER BY created_at DESC LIMIT 1')).rows[0];
  if (realIncident) {
    const resForeign = await call('post', '/incidents/:id/documents', {
      params: { id: realIncident.id },
      body: { name: 'x.pdf', storage_path: 'ncr/11111111-1111-1111-1111-111111111111/x.pdf' },
    });
    check('a path outside the incident folder → 400', resForeign.statusCode === 400, String(resForeign.statusCode));
  } else {
    check('a path outside the incident folder → 400', false, 'no incident to test with');
  }

  console.log('== [7] PATCH /reports/incidents/:id ==');
  const target = body.incidents.find((i) => i.has_ncr) || body.incidents[0];
  if (target) {
    const resPatch = await call('patch', '/incidents/:id', {
      params: { id: target.id },
      body: { notes: 'patched by route test' },
    });
    check('PATCH 200', resPatch.statusCode === 200, JSON.stringify(resPatch.body).slice(0, 200));
    check('PATCH returns the incident', resPatch.body?.incident?.id === target.id);
    await query('UPDATE incidents SET notes = $2 WHERE id = $1', [target.id, target.notes || null]);
  }

  console.log('== [8] single incident + its NCR document ==');
  if (target) {
    const resOne = await call('get', '/incidents/:id', { params: { id: target.id } });
    check('GET /incidents/:id → 200', resOne.statusCode === 200, JSON.stringify(resOne.body).slice(0, 200));
    check('incident + ncr_forms + documents returned',
      !!resOne.body?.incident && Array.isArray(resOne.body?.ncr_forms) && Array.isArray(resOne.body?.documents));

    const resNcr = await call('get', '/incidents/:id/ncr', { params: { id: target.id } });
    if (target.has_ncr) {
      check('GET /incidents/:id/ncr → 200 for an NCR incident', resNcr.statusCode === 200, String(resNcr.statusCode));
      check('NCR form carries form_data', !!(resNcr.body?.form?.form_data));
    } else {
      check('GET /incidents/:id/ncr → 404 when no NCR is stored', resNcr.statusCode === 404, String(resNcr.statusCode));
    }
  }

  console.log('== [9] close an NCR (register action) ==');
  if (target) {
    const resClose = await call('post', '/incidents/:id/close', {
      params: { id: target.id },
      body: { status: 'CLOSED', resolved_by: 'reports-test@srs.local' },
    });
    check('close → 200', resClose.statusCode === 200, JSON.stringify(resClose.body).slice(0, 200));
    check('incident is now CLOSED', resClose.body?.incident?.status === 'CLOSED', resClose.body?.incident?.status);
    // put it back so the fixture stays stable
    await query('UPDATE incidents SET status = $2, resolved_at = NULL WHERE id = $1', [target.id, target.status || 'OPEN']);
  }

  console.log(`reports-routes: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
