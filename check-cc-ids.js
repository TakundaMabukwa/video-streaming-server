// Compares the two cost-centre id spaces: the BACKEND table (what the UI
// selection uses) and the SUPABASE tables (where the vehicle lookup gets a
// vehicle's cost centre). If the ids do not line up, an id comparison in the
// UI compares apples with oranges.
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
  const backend = await db.query('SELECT id, name FROM cost_centers ORDER BY id');
  const supa = await sb('cost_centers', 'id,name');
  const vehicles = await sb('vehiclesc', 'fleet_number,cost_center,cost_centres,cost_center_id');

  console.log('backend cost_centers :', backend.rows.length);
  console.log('supabase cost_centers:', supa.length);

  const byName = new Map();
  for (const c of backend.rows) byName.set(String(c.name).toLowerCase(), c.id);
  const supaById = new Map(supa.map((c) => [c.id, c.name]));

  console.log('');
  console.log('name            | backend_id | supabase_id(same name) | aligned?');
  const mismatched = [];
  for (const c of backend.rows) {
    const sup = supa.find((s) => String(s.name || '').toLowerCase() === String(c.name).toLowerCase());
    const aligned = sup && sup.id === c.id;
    if (!aligned) mismatched.push(c.name);
    console.log(
      String(c.name).padEnd(15),
      '|',
      String(c.id).padStart(10),
      '|',
      String(sup ? sup.id : '-').padStart(24),
      '|',
      aligned ? 'yes' : 'NO'
    );
  }
  console.log('');
  console.log('names with DIFFERENT ids:', mismatched.length, mismatched.join(', ') || '(none)');

  // How many live vehicles are affected: their supabase id points at a cost
  // centre whose id means something else in the backend.
  let affected = 0;
  const examples = [];
  for (const v of vehicles) {
    if (v.cost_center_id == null) continue;
    const supName = String(supaById.get(v.cost_center_id) || v.cost_center || v.cost_centres || '');
    const backendId = byName.get(supName.toLowerCase());
    if (backendId == null) continue;
    if (backendId !== v.cost_center_id) {
      affected++;
      if (examples.length < 6) examples.push(`${v.fleet_number}: supa_id=${v.cost_center_id}(${supName}) -> backend_id=${backendId}`);
    }
  }
  console.log('');
  console.log('vehicles whose supabase cost-centre id != backend id:', affected, 'of', vehicles.length);
  for (const e of examples) console.log('  -', e);

  await db.closePool();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });