'use strict';
// One-time, local-safe identity backfill.
//
//   node scripts/backfill-identity.js          # dry run, reports only
//   node scripts/backfill-identity.js --apply  # writes changes
//
// Rewrites provider ids in alert tables to the canonical fleet_number and keeps
// the original in source_device_id / legacy_device_id. It never touches
// vehicle_status (its PK is provider-scoped) and never merges two open groups.
const db = require('../src/db');

const APPLY = process.argv.includes('--apply');
const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
const compact = (v) => norm(v).replace(/[^A-Z0-9]/g, '');

async function loadMaps() {
  const byFleet = new Map();
  const byAlt = new Map(); // registration / plate / mettax / geotab id / serial
  const add = (map, key, value) => {
    const k = norm(key);
    if (!k) return;
    if (!map.has(k)) map.set(k, value);
  };
  const fleets = (await db.query(
    'SELECT fleet_number, registration_number, mettax_device_id FROM fleet_vehicles'
  )).rows;
  for (const row of fleets) {
    const value = {
      fleet: norm(row.fleet_number),
      registration: norm(row.registration_number) || null,
      mettax: row.mettax_device_id ? String(row.mettax_device_id) : null,
      geotab: null,
    };
    add(byFleet, value.fleet, value);
    add(byAlt, value.registration, value);
    add(byAlt, value.mettax, value);
  }
  const devices = (await db.query(
    'SELECT id, fleet_number, license_plate, serial_number FROM geotab_devices'
  )).rows;
  for (const row of devices) {
    const value = {
      fleet: norm(row.fleet_number),
      registration: norm(row.license_plate) || null,
      mettax: null,
      geotab: row.id ? String(row.id) : null,
    };
    if (!value.fleet) continue;
    const existing = byFleet.get(value.fleet);
    if (existing && existing.mettax) value.mettax = existing.mettax;
    add(byAlt, row.id, value);
    add(byAlt, row.serial_number, value);
    add(byAlt, row.license_plate, value);
    if (!byFleet.has(value.fleet)) byFleet.set(value.fleet, value);
  }
  return { byFleet, byAlt };
}

function resolve(maps, { deviceId, deviceName, fleetNumber, registration }) {
  const fleet = norm(fleetNumber);
  if (fleet && maps.byFleet.has(fleet)) return maps.byFleet.get(fleet);
  for (const key of [registration, deviceId]) {
    const hit = maps.byAlt.get(norm(key)) || maps.byAlt.get(compact(key));
    if (hit) return hit;
  }
  for (const token of String(deviceName || '').split(/[\s/\-()|,]+/)) {
    const hit = maps.byAlt.get(norm(token));
    if (hit) return hit;
  }
  return null;
}

async function collect(table, columns) {
  const rows = [];
  const page = 500;
  let offset = 0;
  for (;;) {
    const res = await db.query(
      `SELECT ${columns} FROM ${table} WHERE source_device_id IS NULL ORDER BY id LIMIT $1 OFFSET $2`,
      [page, offset]
    );
    if (res.rows.length === 0) break;
    rows.push(...res.rows);
    if (res.rows.length < page) break;
    offset += page;
  }
  return rows;
}

async function backfillAlerts(maps) {
  const rows = await collect('alerts', 'id, device_id, device_name, fleet_number, alert_group_id');
  let resolved = 0;
  let skipped = 0;
  for (const row of rows) {
    const hit = resolve(maps, { deviceId: row.device_id, deviceName: row.device_name, fleetNumber: row.fleet_number });
    if (!hit) { skipped++; continue; }
    resolved++;
    if (APPLY) {
      await db.query(
        `UPDATE alerts SET device_id = $2, fleet_number = $2, source_device_id = $3,
           geotab_device_id = $4, mettax_device_id = $5, legacy_device_id = $1
         WHERE id = $6`,
        [row.device_id, hit.fleet, row.device_id, hit.geotab, hit.mettax, row.id]
      );
    }
  }
  return { table: 'alerts', scanned: rows.length, resolved, skipped };
}

async function backfillAlertGroups(maps) {
  const rows = await collect('alert_groups', 'id, device_id, device_name, fleet_number, alarm_type, source_type, resolved, false_alert');
  let resolved = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const row of rows) {
    const hit = resolve(maps, { deviceId: row.device_id, deviceName: row.device_name, fleetNumber: row.fleet_number });
    if (!hit) { skipped++; continue; }
    if (norm(row.device_id) === hit.fleet) { skipped++; continue; }
    if (row.resolved === false && row.false_alert === false) {
      const dup = await db.query(
        `SELECT 1 FROM alert_groups
         WHERE device_id = $1 AND alarm_type = $2 AND source_type = $3
           AND resolved = FALSE AND false_alert = FALSE AND id <> $4 LIMIT 1`,
        [hit.fleet, row.alarm_type, row.source_type, row.id]
      );
      if (dup.rows.length > 0) { conflicts++; continue; }
    }
    resolved++;
    if (APPLY) {
      await db.query(
        `UPDATE alert_groups SET device_id = $2, fleet_number = $2, source_device_id = $3,
           geotab_device_id = $4, mettax_device_id = $5, legacy_device_id = $1
         WHERE id = $6`,
        [row.device_id, hit.fleet, row.device_id, hit.geotab, hit.mettax, row.id]
      );
    }
  }
  return { table: 'alert_groups', scanned: rows.length, resolved, skipped, conflicts };
}

async function backfillTelematics(maps) {
  const rows = await collect('telematics_events', 'id, device_id, license_plate, fleet_number');
  let resolved = 0;
  let skipped = 0;
  for (const row of rows) {
    const hit = resolve(maps, { deviceId: row.device_id, fleetNumber: row.fleet_number, registration: row.license_plate });
    if (!hit) { skipped++; continue; }
    resolved++;
    if (APPLY) {
      await db.query(
        `UPDATE telematics_events SET device_id = $2, fleet_number = $2, source_device_id = $3,
           geotab_device_id = $4, mettax_device_id = $5, legacy_device_id = $1
         WHERE id = $6`,
        [row.device_id, hit.fleet, row.device_id, hit.geotab, hit.mettax, row.id]
      );
    }
  }
  return { table: 'telematics_events', scanned: rows.length, resolved, skipped };
}

(async () => {
  const maps = await loadMaps();
  const results = [
    await backfillAlertGroups(maps),
    await backfillAlerts(maps),
    await backfillTelematics(maps),
  ];
  console.log(APPLY ? 'APPLIED' : 'DRY RUN', JSON.stringify(results, null, 2));
  await db.closePool();
})().catch((err) => { console.error(err); process.exit(1); });
