// One-off reconcile of open zone entries against each vehicle's last known fix.
//
// For every open high_risk_zone_entries row:
//   - zone no longer watched (flags cleared / deleted)  -> close
//   - vehicle's last fix is OUTSIDE the zone polygon     -> close, exit_time = last fix time
//   - vehicle's last fix is INSIDE the zone               -> keep open (genuinely inside)
//   - no usable fix                                      -> keep open, reported
//
// Dry run by default. Pass --apply to write.
//   node scripts/close-stale-zone-entries.js            (report only)
//   node scripts/close-stale-zone-entries.js --apply    (write)
const { Client } = require('pg');
const turf = require('@turf/turf');

const APPLY = process.argv.includes('--apply');

function buildPolygon(points) {
  let p = points;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { return null; }
  }
  if (!Array.isArray(p) || p.length < 3) return null;
  const ring = p.map((q) => [Number(q.x), Number(q.y)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (ring.length < 3) return null;
  const f = ring[0];
  const l = ring[ring.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f);
  try {
    return turf.polygon([ring]);
  } catch {
    return null;
  }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const zoneRows = (await db.query(
      `SELECT id, name, points FROM geotab_zones
       WHERE is_deleted IS NOT TRUE AND (is_high_risk OR is_no_go OR is_no_stopping)`
    )).rows;
    const zones = new Map();
    for (const z of zoneRows) {
      const poly = buildPolygon(z.points);
      if (poly) zones.set(z.id, { name: z.name, poly });
    }

    const fixes = new Map(
      (await db.query(`SELECT device_id, latitude, longitude, last_log_time FROM vehicle_status`)).rows
        .map((r) => [r.device_id, r])
    );

    const open = (await db.query(
      `SELECT id, device_id, zone_id, zone_name, entry_time FROM high_risk_zone_entries WHERE is_active = TRUE ORDER BY id`
    )).rows;

    const plan = { closeUnwatched: [], closeOutside: [], keepInside: [], noFix: [] };
    for (const e of open) {
      const zone = zones.get(e.zone_id);
      if (!zone) {
        plan.closeUnwatched.push({ id: e.id, exit: null });
        continue;
      }
      const fix = fixes.get(e.device_id);
      if (!fix || fix.latitude == null || fix.longitude == null || !fix.last_log_time) {
        plan.noFix.push(e.id);
        continue;
      }
      const inside = turf.booleanPointInPolygon(turf.point([Number(fix.longitude), Number(fix.latitude)]), zone.poly);
      if (inside) {
        plan.keepInside.push(e.id);
      } else {
        const fixTime = new Date(fix.last_log_time);
        const entryTime = new Date(e.entry_time);
        plan.closeOutside.push({ id: e.id, exit: fixTime > entryTime ? fixTime.toISOString() : entryTime.toISOString() });
      }
    }

    console.log(`open entries: ${open.length}`);
    console.log(`  close (zone unwatched):   ${plan.closeUnwatched.length}`);
    console.log(`  close (outside by fix):   ${plan.closeOutside.length}`);
    console.log(`  keep  (inside by fix):    ${plan.keepInside.length}`);
    console.log(`  keep  (no usable fix):    ${plan.noFix.length}`);

    if (!APPLY) {
      console.log('dry run: nothing written. Re-run with --apply to close.');
      return;
    }

    let closed = 0;
    for (const row of plan.closeOutside) {
      const r = await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = $2 WHERE id = $1 AND is_active = TRUE`,
        [row.id, row.exit]
      );
      closed += r.rowCount;
    }
    for (const row of plan.closeUnwatched) {
      const r = await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = COALESCE(exit_time, NOW()) WHERE id = $1 AND is_active = TRUE`,
        [row.id]
      );
      closed += r.rowCount;
    }
    console.log(`closed ${closed} entries`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
