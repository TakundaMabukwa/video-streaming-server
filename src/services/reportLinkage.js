// Reports linkage resolver.
//
// One place decides which cost centre a row belongs to and which driver it
// belongs to. Every /eps/reports/* endpoint uses it, so the register, the
// cost-centre cards and the driver rows can never disagree.
//
// Vehicle cost centre (first hit wins):
//   1. the cost centre stored on the incident row (written when the NCR was
//      saved)
//   2. fleet_vehicles by fleet number
//   3. fleet_vehicles by REGISTRATION — the fleet number in the alert name
//      is often a Geotab label ("LSA11") while the registry calls the same
//      truck "LSA/CB26", so the plate is the reliable join key
//   4. driver_scoring by fleet number (a fleet registered for a cost centre)
//   5. the driver's own cost centre (Supabase drivers)
//   6. nothing → Unassigned (VISIBLE, never dropped)
//
// Driver identity (first hit wins):
//   1. id_number → Supabase drivers.id_or_passport_number (exact)
//   2. driver name → Supabase drivers first/surname
//   3. fleet number → driver_scoring (local mirror with driver + cost centre)
//   4. the raw name on the row
const { query } = require('../db/pool');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Small registries (loaded once per request, cached briefly) ─────────────
const REGISTRY_TTL_MS = 60 * 1000;
let registryCache = null;
let registryCachedAt = 0;

async function loadRegistry() {
  const now = Date.now();
  if (registryCache && now - registryCachedAt < REGISTRY_TTL_MS) return registryCache;

  const [fvRes, dsRes] = await Promise.all([
    query(
      `SELECT fleet_number, registration_number, cost_center_id
         FROM fleet_vehicles
        WHERE fleet_number IS NOT NULL OR registration_number IS NOT NULL`
    ).catch(() => ({ rows: [] })),
    query(
      `SELECT fleet_number, driver, cost_center_id, registration_number
         FROM driver_scoring
        WHERE fleet_number IS NOT NULL`
    ).catch(() => ({ rows: [] })),
  ]);

  const byFleet = new Map();
  const byRegistration = new Map();
  for (const row of fvRes.rows || []) {
    const fk = normKey(row.fleet_number);
    const rk = normKey(row.registration_number);
    const entry = {
      fleet: row.fleet_number || null,
      registration: row.registration_number || null,
      ccId: row.cost_center_id == null ? null : Number(row.cost_center_id),
    };
    if (fk && !byFleet.has(fk)) byFleet.set(fk, entry);
    if (rk && !byRegistration.has(rk)) byRegistration.set(rk, entry);
  }

  const scoringByFleet = new Map();
  for (const row of dsRes.rows || []) {
    const fk = normKey(row.fleet_number);
    if (!fk) continue;
    const entry = {
      fleet: row.fleet_number || null,
      driver: row.driver || null,
      ccId: row.cost_center_id == null ? null : Number(row.cost_center_id),
      registration: row.registration_number || null,
    };
    if (!scoringByFleet.has(fk)) scoringByFleet.set(fk, entry);
  }

  registryCache = { byFleet, byRegistration, scoringByFleet };
  registryCachedAt = now;
  return registryCache;
}

// ── Supabase drivers (5-min cache — never fetched per row) ─────────────────
const DRIVERS_TTL_MS = 5 * 60 * 1000;
let driversCache = null;
let driversCachedAt = 0;

function normKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function loadSupabaseDrivers() {
  const now = Date.now();
  if (driversCache && now - driversCachedAt < DRIVERS_TTL_MS) return driversCache;

  const empty = { byIdNumber: new Map(), byName: new Map(), byFleet: new Map(), list: [] };
  if (!SUPABASE_URL || !SUPABASE_KEY) return empty;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/drivers?select=id,first_name,surname,fleet_number,cost_center_id,id_or_passport_number`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return empty;
    const rows = await res.json();
    if (!Array.isArray(rows)) return empty;

    const byIdNumber = new Map();
    const byName = new Map();
    const byFleet = new Map();
    const list = [];
    for (const row of rows) {
      const driver = {
        id: row.id == null ? null : String(row.id),
        firstName: row.first_name || null,
        surname: row.surname || null,
        fleetNumber: row.fleet_number || null,
        ccId: row.cost_center_id == null ? null : Number(row.cost_center_id),
        idNumber: row.id_or_passport_number || null,
      };
      list.push(driver);
      const idn = normKey(driver.idNumber);
      if (idn && !byIdNumber.has(idn)) byIdNumber.set(idn, driver);
      const full = normName(`${driver.firstName || ''} ${driver.surname || ''}`);
      if (full && !byName.has(full)) byName.set(full, driver);
      const first = normName(driver.firstName);
      if (first && !byName.has(first)) byName.set(first, driver);
      const fk = normKey(driver.fleetNumber);
      if (fk && !byFleet.has(fk)) byFleet.set(fk, driver);
    }

    driversCache = { byIdNumber, byName, byFleet, list };
    driversCachedAt = now;
    return driversCache;
  } catch (err) {
    console.error('[ReportLinkage] Supabase drivers fetch failed:', err.message);
    return empty;
  }
}

// ── Name tokens: every chunk of the device name, suffix-stripped ─────────
// "LSA11 - KXH512MP" → ["LSA11", "KXH512MP"]
// "RH39 (RAPID) - JFP870FS" → ["RH39", "JFP870FS"] (RAPID/REMCO stripped
// so the Geotab label still matches the registry fleet number)
function nameTokens(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    for (const part of raw.split(/[^A-Za-z0-9]+/)) {
      if (!part || part.length < 4) continue;
      const variants = new Set([part, part.replace(/RAPID/i, ''), part.replace(/REMCO/i, '')]);
      for (const variant of variants) {
        const token = variant.trim();
        if (!token || token.length < 4) continue;
        const key = token.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(token);
      }
    }
  }
  return out;
}

/**
 * Resolve one row (incident or closed alert group) to its vehicle cost
 * centre, driver identity and driver cost centre.
 *
 * @param {object} row  { incident_id?, alert_id?, alert_group_key?, device_id?,
 *                        device_name?, fleet_number?, driver_name?, id_number?,
 *                        cost_center_id? }
 */
async function resolveRow(row, ctx) {
  const registry = ctx.registry;
  const drivers = ctx.drivers;

  const storedFleet = normKey(row.fleet_number);
  const tokens = nameTokens(row.device_name, row.fleet_number, row.device_id);

  // 1) vehicle via REGISTRATION (the plate) — the physical truth. The fleet
  //    label in an alert name is often a Geotab label ("LSA11") while the
  //    registry calls the same truck "LSA/CB26", so the plate is the only
  //    reliable join key. It also outranks a fleet label that points at a
  //    DIFFERENT truck (stale driver_scoring rows).
  let vehicle = null;
  for (const token of tokens) {
    const hit = registry.byRegistration.get(normKey(token));
    if (hit) { vehicle = hit; break; }
  }

  // 2) vehicle via fleet number
  if (!vehicle && storedFleet) {
    vehicle = registry.byFleet.get(storedFleet) || null;
  }

  // 3) vehicle via fleet label variants (RH39 (RAPID) → RH39)
  if (!vehicle) {
    for (const token of tokens) {
      const hit = registry.byFleet.get(normKey(token));
      if (hit) { vehicle = hit; break; }
    }
  }

  // 4) scoring mirror by fleet (a fleet registered for a cost centre)
  let scoring = storedFleet ? registry.scoringByFleet.get(storedFleet) || null : null;
  if (!scoring) {
    for (const token of tokens) {
      const hit = registry.scoringByFleet.get(normKey(token));
      if (hit) { scoring = hit; break; }
    }
  }

  // ── driver identity ───────────────────────────────────────────────────
  let driver = null;
  let driverSource = null;
  const idNumber = normKey(row.id_number);
  if (idNumber && drivers.byIdNumber.has(idNumber)) {
    driver = drivers.byIdNumber.get(idNumber);
    driverSource = 'id_number';
  }
  if (!driver) {
    const rawName = String(row.driver_name || '').trim();
    const nameKey = normName(rawName);
    if (nameKey && drivers.byName.has(nameKey)) {
      driver = drivers.byName.get(nameKey);
      driverSource = 'name';
    }
  }
  if (!driver && scoring && scoring.driver) {
    driver = {
      id: null,
      firstName: null,
      surname: null,
      fleetNumber: scoring.fleet,
      ccId: scoring.ccId,
      idNumber: null,
    };
    driverSource = 'fleet';
  }

  const driverName = driver
    ? [driver.firstName, driver.surname].filter(Boolean).join(' ').trim() || null
    : (scoring && scoring.driver) || (row.driver_name ? String(row.driver_name).trim() : null) || null;

  // ── cost centres ─────────────────────────────────────────────────────
  const storedCc = row.cost_center_id == null ? null : Number(row.cost_center_id);
  const vehicleCc = vehicle && vehicle.ccId != null ? vehicle.ccId : null;
  const scoringCc = scoring && scoring.ccId != null ? scoring.ccId : null;
  const driverCc = driver && driver.ccId != null ? driver.ccId : null;

  let ccId = storedCc;
  let ccSource = ccId != null ? 'incident' : null;
  if (ccId == null && vehicleCc != null) { ccId = vehicleCc; ccSource = 'vehicle'; }
  if (ccId == null && scoringCc != null) { ccId = scoringCc; ccSource = 'fleet_scoring'; }
  if (ccId == null && driverCc != null) { ccId = driverCc; ccSource = 'driver'; }

  // The vehicle's cost centre is reported separately so the frontend can
  // match on EITHER the vehicle's or the driver's cost centre.
  const vehicleCcFinal = vehicleCc != null ? vehicleCc : (ccSource === 'vehicle' ? ccId : null);
  const driverCcFinal = driverCc != null ? driverCc : (ccSource === 'driver' ? ccId : null);

  return {
    vehicle_cc_id: vehicleCcFinal,
    driver_cc_id: driverCcFinal,
    cc_id: ccId,
    cc_source: ccSource,
    vehicle_fleet: vehicle ? vehicle.fleet : (scoring ? scoring.fleet : row.fleet_number || null),
    vehicle_registration: vehicle ? vehicle.registration : (scoring ? scoring.registration : null),
    driver_key: driver && driver.id ? `sb:${driver.id}` : (driverName ? `name:${normName(driverName)}` : null),
    driver_name: driverName,
    driver_source: driverSource,
    driver_fleet: driver && driver.fleetNumber ? driver.fleetNumber : null,
  };
}

async function createContext() {
  const [registry, drivers] = await Promise.all([loadRegistry(), loadSupabaseDrivers()]);
  return { registry, drivers };
}

async function resolveRows(rows) {
  const ctx = await createContext();
  const out = [];
  for (const row of rows || []) {
    out.push(await resolveRow(row, ctx));
  }
  return out;
}

function invalidateCaches() {
  registryCache = null;
  registryCachedAt = 0;
  driversCache = null;
  driversCachedAt = 0;
}

module.exports = {
  createContext,
  resolveRow,
  resolveRows,
  loadRegistry,
  loadSupabaseDrivers,
  nameTokens,
  normKey,
  normName,
  invalidateCaches,
};
