// Canonical vehicle identity.
//
// The frontend identifies a vehicle by its fleet number. Every provider uses a
// different id (Geotab device id, camera IMEI, Soltrack registration), so all
// write paths resolve to one canonical fleet_number and keep the provider id
// in a dedicated column. This is the only place that maps between them.

const db = require('../db');

const TTL_MS = 5 * 60 * 1000;

let cache = null;
let loadedAt = 0;
let loading = null;

const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
const compact = (v) => norm(v).replace(/[^A-Z0-9]/g, '');

function tokens(value) {
  const out = [];
  const seen = new Set();
  for (const raw of String(value || '').split(/[\s/\-()|,]+/)) {
    const t = norm(raw);
    if (!t || t.length < 2 || t.length > 24) continue;
    if (!/^[A-Z0-9]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function pickPreferred(rows) {
  if (!rows || rows.length === 0) return null;
  return rows
    .slice()
    .sort((a, b) => {
      const active = Number(b.is_active !== false) - Number(a.is_active !== false);
      if (active) return active;
      const at = a.active_from ? new Date(a.active_from).getTime() : 0;
      const bt = b.active_from ? new Date(b.active_from).getTime() : 0;
      return bt - at;
    })[0];
}

function add(map, key, value) {
  const k = norm(key);
  if (!k) return;
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(value);
}

async function load() {
  const [fleetRes, geotabRes, scoringRes] = await Promise.all([
    db.query(
      `SELECT fleet_number, registration_number, mettax_device_id, cost_center_id
         FROM fleet_vehicles
        WHERE fleet_number IS NOT NULL AND fleet_number <> ''`
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT id, fleet_number, license_plate, serial_number, is_active, active_from
         FROM geotab_devices`
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT fleet_number, cost_center_id FROM driver_scoring
        WHERE fleet_number IS NOT NULL AND fleet_number <> ''`
    ).catch(() => ({ rows: [] })),
  ]);

  const byFleet = new Map();
  const byReg = new Map();
  const byMettax = new Map();
  const byGeotab = new Map();
  const ccByFleet = new Map();

  for (const row of fleetRes.rows) {
    const fleet = norm(row.fleet_number);
    if (!fleet) continue;
    const entry = {
      fleetNumber: fleet,
      registration: norm(row.registration_number) || null,
      mettaxDeviceId: row.mettax_device_id ? String(row.mettax_device_id) : null,
      geotabDeviceId: null,
      costCenterId: row.cost_center_id == null ? null : Number(row.cost_center_id),
    };
    add(byFleet, fleet, entry);
    if (entry.registration) add(byReg, entry.registration, entry);
    if (entry.mettaxDeviceId) add(byMettax, entry.mettaxDeviceId, entry);
    if (entry.costCenterId != null) ccByFleet.set(fleet, entry.costCenterId);
  }

  // driver_scoring is a fallback cost-centre source (fleet_vehicles wins).
  for (const row of scoringRes.rows) {
    const fleet = norm(row.fleet_number);
    if (!fleet || row.cost_center_id == null) continue;
    if (!ccByFleet.has(fleet)) ccByFleet.set(fleet, Number(row.cost_center_id));
  }

  for (const row of geotabRes.rows) {
    const fleet = norm(row.fleet_number);
    if (!fleet) continue;
    const entry = {
      fleetNumber: fleet,
      registration: norm(row.license_plate) || null,
      mettaxDeviceId: null,
      geotabDeviceId: row.id ? String(row.id) : null,
      costCenterId: ccByFleet.has(fleet) ? ccByFleet.get(fleet) : null,
      is_active: row.is_active,
      active_from: row.active_from,
    };
    add(byGeotab, row.id, entry);
    if (row.serial_number) add(byGeotab, row.serial_number, entry);
    if (entry.registration) add(byReg, entry.registration, entry);
  }

  // Fill cost centres on fleet-registry entries that lacked one.
  for (const list of byFleet.values()) {
    for (const entry of list) {
      if (entry.costCenterId == null && ccByFleet.has(entry.fleetNumber)) {
        entry.costCenterId = ccByFleet.get(entry.fleetNumber);
      }
    }
  }

  cache = { byFleet, byReg, byMettax, byGeotab };
  loadedAt = Date.now();
  return cache;
}

async function ensureLoaded() {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  if (loading) return loading;
  loading = load().finally(() => { loading = null; });
  return loading;
}

function invalidate() {
  cache = null;
  loadedAt = 0;
}

function firstHit(map, key) {
  if (!map || !key) return null;
  const rows = map.get(norm(key));
  if (!rows || rows.length === 0) return null;
  const preferred = pickPreferred(rows);
  return preferred || null;
}

function enrich(entry, map) {
  if (!entry) return entry;
  const fleetEntry = firstHit(map.byFleet, entry.fleetNumber);
  if (!fleetEntry) return entry;
  return {
    ...fleetEntry,
    ...entry,
    mettaxDeviceId: entry.mettaxDeviceId || fleetEntry.mettaxDeviceId || null,
    registration: entry.registration || fleetEntry.registration || null,
    costCenterId: entry.costCenterId == null ? fleetEntry.costCenterId : entry.costCenterId,
  };
}

function withProviderIds(entry, map, deviceId, mettax) {
  if (!entry) return entry;
  const g = deviceId ? (firstHit(map.byGeotab, deviceId) || firstHit(map.byMettax, deviceId)) : null;
  return {
    ...entry,
    geotabDeviceId: entry.geotabDeviceId || g?.geotabDeviceId || null,
    mettaxDeviceId: entry.mettaxDeviceId || g?.mettaxDeviceId || mettax || null,
  };
}

function toResult(entry, sourceDeviceId) {
  if (!entry) return null;
  return {
    fleetNumber: entry.fleetNumber,
    registration: entry.registration || null,
    mettaxDeviceId: entry.mettaxDeviceId || null,
    geotabDeviceId: entry.geotabDeviceId || null,
    costCenterId: entry.costCenterId == null ? null : Number(entry.costCenterId),
    sourceDeviceId: sourceDeviceId == null ? null : String(sourceDeviceId),
  };
}

/**
 * Resolve any provider identity to the canonical fleet_number.
 * @param {{fleetNumber?:string, registration?:string, deviceId?:string,
 *          deviceName?:string, mettaxDeviceId?:string}} input
 */
async function resolveVehicle(input = {}) {
  const map = await ensureLoaded();
  const fleetNumber = norm(input.fleetNumber);
  const registration = norm(input.registration);
  const deviceId = norm(input.deviceId);
  const deviceName = input.deviceName;
  const mettax = norm(input.mettaxDeviceId);
  const sourceDeviceId = input.deviceId != null ? String(input.deviceId) : null;

  let hit = firstHit(map.byFleet, fleetNumber);
  if (hit) return toResult(withProviderIds(enrich(hit, map), map, deviceId, mettax), sourceDeviceId);

  hit = firstHit(map.byReg, registration) || firstHit(map.byReg, compact(registration));
  if (hit) return toResult(withProviderIds(enrich(hit, map), map, deviceId, mettax), sourceDeviceId);

  if (mettax) {
    hit = firstHit(map.byMettax, mettax);
    if (hit) return toResult(withProviderIds(enrich(hit, map), map, deviceId, mettax), sourceDeviceId);
  }

  if (deviceId) {
    hit = firstHit(map.byGeotab, deviceId) || firstHit(map.byMettax, deviceId);
    if (hit) return toResult(withProviderIds(enrich(hit, map), map, deviceId, mettax), sourceDeviceId);
  }

  // Name fallback: "EX55 - LDR065MP", "32 - EX55 - LCL660MP", "PB29 (RAPID)".
  for (const token of tokens(deviceName)) {
    hit = firstHit(map.byFleet, token) || firstHit(map.byReg, token);
    if (hit) return toResult(withProviderIds(enrich(hit, map), map, deviceId, mettax), sourceDeviceId);
  }

  return null;
}

/** Canonical device id for every alert/telemetry write. */
async function canonicalDeviceId(input = {}) {
  const resolved = await resolveVehicle(input);
  return resolved ? resolved.fleetNumber : null;
}

function peekCache() {
  return cache;
}

module.exports = {
  resolveVehicle,
  canonicalDeviceId,
  invalidate,
  peekCache,
  _internal: { tokens, compact, norm },
};
