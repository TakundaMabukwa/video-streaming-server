// Reports linkage resolver.
//
// Supabase is the source of truth:
//   vehiclesc      -> vehicle identity + cost centre
//   cost_centers   -> cost centre names/codes
//   drivers        -> driver identity + cost centre
//
// Vehicle matching is fleet-code first ("B29 - KXH548MP" -> "B29"), then all
// known vehicle aliases (registration, vehicle number, call number, old/temp
// numbers, asset number) before falling back to a stored incident cost centre.
const { query } = require('../db/pool');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const REGISTRY_TTL_MS = 10 * 60 * 1000;
let registryCache = null;
let registryCachedAt = 0;
let registryInFlight = null;

const DRIVERS_TTL_MS = 5 * 60 * 1000;
let driversCache = null;
let driversCachedAt = 0;

function normKey(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function fleetCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const beforeDash = raw.split(/\s*[-\u2013\u2014]\s*/)[0] || raw;
  return normKey(beforeDash);
}

function nameTokens(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const parts = raw.split(/[^A-Za-z0-9]+/);
    for (const part of parts) {
      if (!part || part.length < 2) continue;
      for (const variant of [part, part.replace(/RAPID/i, ''), part.replace(/REMCO/i, '')]) {
        const key = normKey(variant);
        if (!key || key.length < 2 || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

function deviceCandidates(row) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const key = normKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  push(row.fleet_number);
  push(fleetCode(row.fleet_number));
  push(fleetCode(row.device_name));
  push(row.device_id);

  const device = String(row.device_name || '').trim();
  if (device) {
    const parts = device.split(/\s*[-\u2013\u2014]\s*/);
    push(parts[0]);
    push(parts[parts.length - 1]);
    for (const token of nameTokens(device)) push(token);
  }
  for (const token of nameTokens(row.fleet_number)) push(token);
  return out;
}

async function supabaseGet(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[ReportLinkage] Supabase ${path} failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[ReportLinkage] Supabase ${path} failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadFallbackRegistry() {
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

  const byAlias = new Map();
  for (const row of fvRes.rows || []) {
    const entry = {
      id: null,
      fleet: row.fleet_number || null,
      registration: row.registration_number || null,
      ccId: row.cost_center_id == null ? null : Number(row.cost_center_id),
      ccText: null,
      driverId: null,
    };
    for (const value of [row.fleet_number, row.registration_number]) {
      const key = normKey(value);
      if (key && !byAlias.has(key)) byAlias.set(key, entry);
    }
  }

  const scoringByFleet = new Map();
  for (const row of dsRes.rows || []) {
    const key = normKey(row.fleet_number);
    if (!key) continue;
    scoringByFleet.set(key, {
      fleet: row.fleet_number || null,
      registration: row.registration_number || null,
      ccId: row.cost_center_id == null ? null : Number(row.cost_center_id),
      driver: row.driver || null,
    });
  }

  return { byAlias, scoringByFleet, costCenters: [], vehicleCountByCc: new Map() };
}

async function loadRegistry() {
  const now = Date.now();
  if (registryCache && now - registryCachedAt < REGISTRY_TTL_MS) return registryCache;
  if (registryInFlight) return registryInFlight;

  registryInFlight = (async () => {
    const vehicleSelect = [
      'id',
      'fleet_number',
      'registration_number',
      'vehicle_number',
      'vehicle_call_number',
      'register_number',
      'old_number',
      'temp_number',
      'licence_number',
      'asset_number',
      'cost_center_id',
      'cost_center',
      'cost_centres',
      'driver_id',
    ].join(',');

    const [vehicles, costCenters] = await Promise.all([
      supabaseGet(`vehiclesc?select=${vehicleSelect}&limit=10000`),
      supabaseGet('cost_centers?select=id,name,code,is_active&limit=500'),
    ]);

    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      const fallback = await loadFallbackRegistry();
      registryCache = fallback;
      registryCachedAt = Date.now();
      return fallback;
    }

    const ccRows = Array.isArray(costCenters) ? costCenters : [];
    const ccById = new Map();
    const ccByText = new Map();
    for (const cc of ccRows) {
      const id = Number(cc.id);
      if (!Number.isFinite(id)) continue;
      ccById.set(id, cc);
      for (const value of [cc.name, cc.code]) {
        const key = normText(value);
        if (key && !ccByText.has(key)) ccByText.set(key, id);
      }
    }

    const byAlias = new Map();
    const vehicleCountByCc = new Map();
    const ordered = [...vehicles].sort((a, b) => {
      const aHas = a.cost_center_id == null ? 1 : 0;
      const bHas = b.cost_center_id == null ? 1 : 0;
      return aHas - bHas || Number(a.id || 0) - Number(b.id || 0);
    });

    for (const row of ordered) {
      const ccId = row.cost_center_id == null ? null : Number(row.cost_center_id);
      const ccText = row.cost_center || row.cost_centres || null;
      const entry = {
        id: row.id == null ? null : String(row.id),
        fleet: row.fleet_number || null,
        registration: row.registration_number || null,
        ccId: Number.isFinite(ccId) ? ccId : null,
        ccText,
        driverId: row.driver_id == null ? null : String(row.driver_id),
      };
      if (entry.ccId != null) {
        vehicleCountByCc.set(entry.ccId, (vehicleCountByCc.get(entry.ccId) || 0) + 1);
      }
      const aliases = [
        row.fleet_number,
        fleetCode(row.fleet_number),
        row.registration_number,
        row.vehicle_number,
        row.vehicle_call_number,
        row.register_number,
        row.old_number,
        row.temp_number,
        row.licence_number,
        row.asset_number,
      ];
      for (const value of aliases) {
        const key = normKey(value);
        if (key && !byAlias.has(key)) byAlias.set(key, entry);
      }
    }

    registryCache = {
      byAlias,
      scoringByFleet: new Map(),
      costCenters: ccRows,
      ccById,
      ccByText,
      vehicleCountByCc,
    };
    registryCachedAt = Date.now();
    return registryCache;
  })();

  try {
    return await registryInFlight;
  } finally {
    registryInFlight = null;
  }
}

async function loadSupabaseDrivers() {
  const now = Date.now();
  if (driversCache && now - driversCachedAt < DRIVERS_TTL_MS) return driversCache;

  const empty = { byIdNumber: new Map(), byName: new Map(), byFleet: new Map(), byId: new Map(), list: [] };
  if (!SUPABASE_URL || !SUPABASE_KEY) return empty;

  const rows = await supabaseGet(
    'drivers?select=id,first_name,surname,fleet_number,cost_center_id,id_or_passport_number&limit=10000'
  );
  if (!Array.isArray(rows)) return empty;

  const byIdNumber = new Map();
  const byName = new Map();
  const byFleet = new Map();
  const byId = new Map();
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
    if (driver.id) byId.set(driver.id, driver);
    const idn = normKey(driver.idNumber);
    if (idn && !byIdNumber.has(idn)) byIdNumber.set(idn, driver);
    const full = normName(`${driver.firstName || ''} ${driver.surname || ''}`);
    if (full && !byName.has(full)) byName.set(full, driver);
    const first = normName(driver.firstName);
    if (first && !byName.has(first)) byName.set(first, driver);
    const fk = normKey(driver.fleetNumber);
    if (fk && !byFleet.has(fk)) byFleet.set(fk, driver);
  }

  driversCache = { byIdNumber, byName, byFleet, byId, list };
  driversCachedAt = Date.now();
  return driversCache;
}

function resolveRow(row, ctx) {
  const registry = ctx.registry;
  const drivers = ctx.drivers;
  const candidates = deviceCandidates(row);

  let vehicle = null;
  for (const key of candidates) {
    const hit = registry.byAlias.get(key);
    if (hit) { vehicle = hit; break; }
  }

  let scoring = null;
  if (!vehicle) {
    for (const key of candidates) {
      const hit = registry.scoringByFleet.get(key);
      if (hit) { scoring = hit; break; }
    }
  }

  let driver = null;
  let driverSource = null;
  const idNumber = normKey(row.id_number);
  if (idNumber && drivers.byIdNumber.has(idNumber)) {
    driver = drivers.byIdNumber.get(idNumber);
    driverSource = 'id_number';
  }
  if (!driver && vehicle && vehicle.driverId && drivers.byId.has(vehicle.driverId)) {
    driver = drivers.byId.get(vehicle.driverId);
    driverSource = 'vehicle';
  }
  if (!driver) {
    const rawName = String(row.driver_name || '').trim();
    const nameKey = normName(rawName);
    if (nameKey && drivers.byName.has(nameKey)) {
      driver = drivers.byName.get(nameKey);
      driverSource = 'name';
    }
  }
  if (!driver) {
    for (const key of candidates) {
      if (drivers.byFleet.has(key)) {
        driver = drivers.byFleet.get(key);
        driverSource = 'fleet';
        break;
      }
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

  const storedCc = row.cost_center_id == null ? null : Number(row.cost_center_id);
  let vehicleCc = vehicle && vehicle.ccId != null ? vehicle.ccId : null;

  if (vehicleCc == null && vehicle) {
    for (const value of [vehicle.ccText, vehicle.fleet]) {
      const key = normText(value);
      const fromText = key ? registry.ccByText?.get(key) : null;
      if (fromText != null) { vehicleCc = fromText; break; }
    }
  }

  const scoringCc = scoring && scoring.ccId != null ? scoring.ccId : null;
  const driverCc = driver && driver.ccId != null ? driver.ccId : null;

  let ccId = vehicleCc;
  let ccSource = ccId != null ? 'vehicle' : null;
  if (ccId == null && scoringCc != null) { ccId = scoringCc; ccSource = 'fleet_scoring'; }
  if (ccId == null && driverCc != null) { ccId = driverCc; ccSource = 'driver'; }
  if (ccId == null && storedCc != null) { ccId = storedCc; ccSource = 'incident'; }

  const cc = ccId == null ? null : registry.ccById?.get(ccId) || null;
  const vehicleCcFinal = vehicleCc != null ? vehicleCc : (ccSource === 'vehicle' ? ccId : null);
  const driverCcFinal = driverCc != null ? driverCc : (ccSource === 'driver' ? ccId : null);

  return {
    vehicle_cc_id: vehicleCcFinal,
    driver_cc_id: driverCcFinal,
    cc_id: ccId,
    cc_name: cc?.name || (ccId == null ? null : `CC ${ccId}`),
    cc_source: ccSource,
    vehicle_fleet: vehicle ? vehicle.fleet : (scoring ? scoring.fleet : row.fleet_number || null),
    vehicle_registration: vehicle ? vehicle.registration : (scoring ? scoring.registration : null),
    driver_key: driver && driver.id ? `sb:${driver.id}` : (driverName ? `name:${normName(driverName)}` : null),
    driver_name: driverName,
    driver_source: driverSource,
    driver_fleet: driver && driver.fleetNumber ? driver.fleetNumber : null,
    mapping_error: ccId == null ? 'no_cost_centre' : null,
  };
}

async function createContext() {
  const [registry, drivers] = await Promise.all([loadRegistry(), loadSupabaseDrivers()]);
  return { registry, drivers };
}

async function resolveRows(rows) {
  const ctx = await createContext();
  return (rows || []).map((row) => resolveRow(row, ctx));
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
  fleetCode,
  normKey,
  normName,
  invalidateCaches,
};
