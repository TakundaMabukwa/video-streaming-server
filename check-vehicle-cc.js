// Compares the vehicle registries: SUPABASE vehiclesc (what the dashboard's
// vehicle lookup uses) vs the BACKEND fleet_vehicles table. If a vehicle is
// assigned to a different cost centre in the two, the board would file it
// under a cost centre the operator did not select.
process.env.DATABASE_URL = process.env.DATABASE_URL;

const db = require('/app/src/db');

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

async function sb(table, select) {
  const res = await fetch(url + '/rest/v1/' + table + '?select=' + select, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  if (!res.ok) throw new Error(table + ' -> ' + res.status);
  return res.json();
}

(async () => {
  const supa = await sb('vehiclesc', 'fleet_number,registration_number,cost_center,cost_centres,cost_center_id');
  const backend = await db.query('SELECT fleet_number, cost_center, cost_center_id FROM fleet_vehicles');
  const bByFleet = new Map(backend.rows.map((r) => [String(r.fleet_number || '').toUpperCase(), r]));

  let compared = 0;
  let disagree = [];
  let supaOnly = 0;
  let backendOnly = 0;
  const supaFleets = new Set();

  for (const v of supa) {
    const fleet = String(v.fleet_number || '').toUpperCase();
    if (!fleet) continue;
    supaFleets.add(fleet);
    const b = bByFleet.get(fleet);
    if (!b) { supaOnly++; continue; }
    compared++;
    const bId = b.cost_center_id == null ? null : Number(b.cost_center_id);
    const sId = v.cost_center_id == null ? null : Number(v.cost_center_id);
    if (bId !== sId) {
      const bName = bId == null ? (b.cost_center || 'NULL') : String(bId);
      const sName = sId == null ? (v.cost_center || v.cost_centres || 'NULL') : String(sId);
      disagree.push(`${fleet}: supa=${sName} backend=${bName}`);
    }
  }
  for (const f of bByFleet.keys()) if (f && !supaFleets.has(f)) backendOnly++;

  console.log('supabase vehiclesc rows      :', supa.length);
  console.log('backend fleet_vehicles rows  :', backend.rows.length);
  console.log('compared by fleet            :', compared);
  console.log('supabase-only vehicles       :', supaOnly);
  console.log('backend-only vehicles        :', backendOnly);
  console.log('');
  console.log('DISAGREEING cost centres     :', disagree.length);
  for (const d of disagree.slice(0, 25)) console.log('  -', d);

  // Which cost centres own how many OPEN groups, by each registry.
  const open = await db.query(
    `SELECT g.fleet_number, count(*) n FROM alert_groups g
     WHERE g.resolved = FALSE AND g.false_alert = FALSE AND g.fleet_number IS NOT NULL
     GROUP BY 1`
  );
  let affected = 0;
  for (const row of open.rows) {
    const fleet = String(row.fleet_number).toUpperCase();
    const s = supa.find((v) => String(v.fleet_number || '').toUpperCase() === fleet);
    const b = bByFleet.get(fleet);
    if (!s || !b) continue;
    const sId = s.cost_center_id == null ? null : Number(s.cost_center_id);
    const bId = b.cost_center_id == null ? null : Number(b.cost_center_id);
    if (sId !== bId) affected += row.n;
  }
  console.log('');
  console.log('OPEN groups whose vehicle is filed under a different CC in the two registries:', affected);

  await db.closePool();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });