const db = require('../db');
const https = require('https');
const { fetchVehiclesFromSupabase } = require('../helpers/supabaseClient');
const { getTelematicsNameMap } = require('../db/alert_definitions');
const { matchAlertDefinition } = require('../helpers/alertMatching');
const { processAlertDeduction } = require('./driverScoringService');
const { escalateSeverity } = require('../helpers/transform');

const GEOTAB_URL = 'https://my.geotab.com/apiv1';

// ── Module state ──

let pollingInterval = null;
let eventPollingInterval = null;
let cachedCredentials = null;
let credentialsExpiry = null;

let lastDeviceVersion = null;
let lastEventVersion = null;
let lastDiagnosticsVersion = null;
let lastLogVersion = null;

// In-memory cache of Geotab rule names keyed by rule id
const ruleNameCache = new Map();

// ── High-risk zone caches (Fix G): zones change rarely, so cache per cycle
//    and cache each device's active zone entries briefly to avoid a DB hit
//    on every single Soltrack frame. ──
const ZONES_CACHE_TTL = 5 * 60 * 1000;
const ACTIVE_ENTRIES_CACHE_TTL = 30 * 1000;
let zonesCache = { data: null, ts: 0 };
const activeEntriesCache = new Map(); // deviceId -> { data, ts }

function invalidateZonesCache() {
  zonesCache = { data: null, ts: 0 };
}

// ── Persistent cursors (sync_state table) ──

const SYNC_STATE_EVENT_VERSION = 'geotab:event_version';

async function getSyncState(key) {
  try {
    const r = await db.query('SELECT value FROM sync_state WHERE key = $1', [key]);
    return r.rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function setSyncState(key, value) {
  try {
    await db.query(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)]
    );
  } catch {
    // sync_state is best-effort; DB replica/-less envs degrade gracefully
  }
}

function getRuleName(ruleId) {
  if (!ruleId) return null;
  if (ruleNameCache.has(ruleId)) return ruleNameCache.get(ruleId);
  return ruleId;
}

// Resolve a Rule name. Cache hit returns instantly; cache miss returns the
// rule id immediately (never blocks the ingest loop) and fetches in background.
function resolveRuleName(credentials, ruleId) {
  if (!ruleId) return null;
  if (ruleNameCache.has(ruleId)) return ruleNameCache.get(ruleId);
  fetchRuleName(credentials, ruleId).catch(() => {});
  return ruleId;
}

async function fetchRuleName(credentials, ruleId) {
  try {
    const response = await geotabGetById(credentials, 'Rule', ruleId);
    if (response.error) return;
    const rules = response.result || [];
    const rule = rules.find((r) => r.id === ruleId);
    if (rule?.name) {
      ruleNameCache.set(ruleId, rule.name);
      db.upsertExceptionRules([{
        id: rule.id,
        name: rule.name,
        description: rule.description || null,
        raw_data: rule,
      }]).catch(() => {});
    }
  } catch {}
}

// Feed page/cycle safety bounds. Events are NEVER capped for storage — the
// pump drains every record the API returns before advancing the cursor.
const MAX_FEED_PUMP_PAGES = 500;
const MAX_DIAGNOSTICS_PER_POLL = 5000;

// ── Geotab feed-version helpers (versions are 16-char zero-padded hex) ──

function hexToBig(hex) {
  return BigInt('0x' + String(hex).replace(/^0+/, '') || '0');
}
function bigToHex(n) {
  return n.toString(16).padStart(16, '0');
}
function hexSub(hex, amount) {
  return bigToHex(hexToBig(hex) - BigInt(amount));
}
function hexLt(a, b) {
  return hexToBig(a) < hexToBig(b);
}

// If the persisted cursor is more than this many versions behind the live head
// the pump would re-drain millions of already-stored records before reaching
// recent events.  Detect this and auto-jump to (head − margin) so only the
// recent tail is processed (deduped), keeping alert latency at minutes instead
// of hours/days.  ~2M versions ≈ a few hours of live traffic at current fleet
// density (~15 versions / exception event).
const STALE_VERSION_MARGIN = 0x2000;

// ── Geotab HTTP helpers ──

function geotabFetch(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(GEOTAB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Geotab response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Geotab request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

async function geotabAuthenticate(database, userName, password) {
  if (cachedCredentials && credentialsExpiry && Date.now() < credentialsExpiry) {
    return cachedCredentials;
  }

  const response = await geotabFetch({
    method: 'Authenticate',
    params: { database, userName, password },
  });

  if (response.error) {
    throw new Error(response.error.message || 'Geotab authentication failed');
  }

  const result = response.result || {};
  cachedCredentials = {
    database: result.credentials?.database || database,
    sessionId: result.credentials?.sessionId,
    userName: result.credentials?.userName || userName,
  };
  credentialsExpiry = Date.now() + (4 * 60 * 60 * 1000);
  console.log('[GEOTAB] Authentication successful');
  return cachedCredentials;
}

function geotabGetFeed(credentials, typeName, fromVersion) {
  const params = { typeName, credentials };
  if (fromVersion !== null && fromVersion !== undefined) {
    params.fromVersion = fromVersion;
  }
  return geotabFetch({
    method: 'GetFeed',
    params,
    id: 10,
    jsonrpc: '2.0',
  });
}

function geotabGet(credentials, typeName) {
  return geotabFetch({
    method: 'Get',
    params: { typeName, credentials },
    id: 10,
    jsonrpc: '2.0',
  });
}

function geotabGetById(credentials, typeName, id) {
  return geotabFetch({
    method: 'Get',
    params: { typeName, credentials, search: { id } },
    id: 10,
    jsonrpc: '2.0',
  });
}

function geotabMultiCall(credentials, calls) {
  return geotabFetch({
    method: 'MultiCall',
    params: { calls, credentials },
    id: 10,
    jsonrpc: '2.0',
  });
}

// ── Sync: Fleet Vehicles from Supabase (midnight only, new vehicles only) ──

async function syncNewFleetVehicles() {
  try {
    const vehicles = await fetchVehiclesFromSupabase();
    if (vehicles.length === 0) {
      console.log('[FLEET] No vehicles returned from Supabase');
      return;
    }

    const enriched = vehicles.map(v => ({
      fleet_number: (v.fleet_number || '').trim() || null,
      registration_number: (v.registration_number || '').trim() || null,
      make: v.make || null,
      model: v.model || null,
      cost_center: v.cost_center || null,
    })).filter(v => v.fleet_number && v.registration_number);

    await db.upsertNewFleetVehicles(enriched);
    console.log(`[FLEET] Midnight sync: ${enriched.length} vehicles fetched (new-only)`);

    // Refresh the Soltrack in-memory fleet dict so new vehicles resolve immediately
    try {
      const soltrackClient = require('./soltrackClient');
      await soltrackClient.refreshFleetDict();
    } catch (err) {
      console.error('[FLEET] Soltrack dict refresh failed:', err.message);
    }
  } catch (error) {
    console.error('[FLEET] Failed to sync new fleet vehicles:', error.message);
  }
}

// ── Sync: Groups ──

async function syncGeotabGroups() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const response = await geotabGet(credentials, 'Group');

    if (response.error) {
      console.error('[GEOTAB] Group error:', response.error.message);
      return;
    }

    const groups = response.result || [];

    if (groups.length > 0) {
      const enriched = groups.map(g => ({
        id: g.id,
        name: g.name,
        parent_id: g.parentGroup?.id || null,
        is_global: g.isGlobalReportingGroup || false,
        raw_data: g,
      }));
      await db.upsertGeotabGroups(enriched);
      console.log(`[GEOTAB] Synced ${groups.length} groups`);
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync groups:', error.message);
  }
}

// ── Sync: Exception Rules ──

async function syncGeotabExceptionRules() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const response = await geotabGet(credentials, 'Rule');

    if (response.error) {
      console.error('[GEOTAB] ExceptionRule error:', response.error.message);
      return;
    }

    const rules = response.result || [];

    if (rules.length > 0) {
      const enriched = rules.map(r => ({
        id: r.id,
        name: r.name || r.id,
        description: r.description || null,
        raw_data: r,
      }));
      await db.upsertExceptionRules(enriched);
      // Update in-memory rule name cache
      for (const r of enriched) {
        ruleNameCache.set(r.id, r.name);
      }
      console.log(`[GEOTAB] Synced ${rules.length} exception rules`);
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync exception rules:', error.message);
  }
}

async function loadRuleNameCache() {
  try {
    const rules = await db.getAllExceptionRules ? await db.getAllExceptionRules() : [];
    for (const r of rules) {
      ruleNameCache.set(r.id, r.name || r.id);
    }
    console.log(`[GEOTAB] Loaded ${ruleNameCache.size} rule names from DB`);
  } catch (err) {
    console.error('[GEOTAB] Failed to load rule cache:', err.message);
  }
}

// ── Sync: Diagnostics ──

async function syncGeotabDiagnostics() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const fromVersion = lastDiagnosticsVersion === null ? -1 : lastDiagnosticsVersion;
    const feed = await geotabGetFeed(credentials, 'Diagnostic', fromVersion);

    if (feed.error) {
      console.error('[GEOTAB] Diagnostic feed error:', feed.error.message);
      return;
    }

    const result = feed.result || {};
    let diagnostics = result.data || [];
    if (result.toVersion) lastDiagnosticsVersion = result.toVersion;

    // On first load, just set the version cursor — don't process millions of old records
    if (fromVersion === -1) {
      console.log(`[GEOTAB] Diagnostic: initialized version cursor (${diagnostics.length} total records, skipping historical)`);
      return;
    }

    if (diagnostics.length === 0) return;

    let diagDropped = 0;
    if (diagnostics.length > MAX_DIAGNOSTICS_PER_POLL) {
      diagDropped = diagnostics.length - MAX_DIAGNOSTICS_PER_POLL;
      diagnostics = diagnostics.slice(0, MAX_DIAGNOSTICS_PER_POLL);
    }

    const enriched = diagnostics.map(d => ({
      id: d.id,
      name: d.name || d.id,
      unit: d.unit || null,
      raw_data: d,
    }));
    await db.upsertDiagnostics(enriched);
    console.log(`[GEOTAB] Synced ${diagnostics.length} diagnostics${diagDropped > 0 ? ` (${diagDropped} dropped - backlog limit)` : ''}`);
  } catch (error) {
    console.error('[GEOTAB] Failed to sync diagnostics:', error.message);
  }
}

// ── Sync: DeviceStatusInfo (current positions) ──

async function syncDeviceStatus() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const response = await geotabGet(credentials, 'DeviceStatusInfo');

    if (response.error) {
      console.error('[GEOTAB] DeviceStatusInfo error:', response.error.message);
      return;
    }

    const devices = response.result || [];
    let updated = 0;

    for (const d of devices) {
      const deviceId = d.device?.id || '';
      if (!deviceId || !d.latitude || !d.longitude) continue;

      const geotabDevice = await db.getGeotabDevice(deviceId);
      if (!geotabDevice) continue; // Only update known fleet devices

      await db.upsertVehicleStatus(deviceId, {
        plate: geotabDevice.name || null,
        licensePlate: geotabDevice.license_plate || null,
        fleetNumber: geotabDevice.fleet_number || null,
        speed: d.speed || null,
        latitude: d.latitude,
        longitude: d.longitude,
        lastLogTime: d.dateTime || null,
      });

      // Real online state from DeviceStatusInfo (previously discarded):
      // isDeviceCommunicating + how long it has been in that state.
      try {
        const communicating = d.isDeviceCommunicating === true;
        let onlineSince = null;
        if (communicating && typeof d.currentStateDuration === 'number' && d.currentStateDuration >= 0) {
          const since = Date.now() - d.currentStateDuration;
          onlineSince = new Date(Math.min(since, Date.now())).toISOString();
        }
        await db.query(
          'UPDATE vehicle_status SET is_online = $2, online_since = $3 WHERE device_id = $1',
          [deviceId, communicating, onlineSince]
        );
      } catch (_) { /* online state must never block position sync */ }

      // Check zone breaches
      if (d.latitude && d.longitude) {
        await checkZoneBreaches(deviceId, d.latitude, d.longitude, d.speed, geotabDevice.fleet_number, geotabDevice.license_plate);
      }
      updated++;
    }

    if (updated > 0) console.log(`[GEOTAB] DeviceStatusInfo: updated ${updated} vehicle positions`);
  } catch (error) {
    console.error('[GEOTAB] Failed to sync device status:', error.message);
  }
}

// ── Sync: Ignition / engine status (real Geotab StatusData) ──
// Two fleet-wide StatusData calls (~200-700ms each) return the latest Ignition
// switch status and Engine speed for every device that reported in the window.
// Devices without a fresh sample keep their last known value; status_seen marks
// the last real sample so consumers (RTMS) can decide when to fall back to the
// legacy speed heuristic.
async function syncIgnitionStatus() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const fromDate = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const diags = [
      { id: 'DiagnosticIgnitionId', kind: 'ignition' },
      { id: 'DiagnosticEngineSpeedId', kind: 'rpm' },
    ];
    const latest = {}; // deviceId -> { ignition?: {val, ts}, rpm?: {val, ts} }

    for (const diag of diags) {
      const res = await geotabFetch({
        method: 'Get',
        params: {
          typeName: 'StatusData',
          search: { diagnosticSearch: { type: 'Diagnostic', id: diag.id }, fromDate },
          credentials,
          resultsLimit: 5000,
        },
        id: 20,
        jsonrpc: '2.0',
      });
      if (res.error) {
        console.error(`[GEOTAB] Ignition status error (${diag.id}):`, res.error.message);
        continue;
      }
      for (const row of res.result || []) {
        const dev = row.device?.id;
        if (!dev) continue;
        const val = Number(row.data?.value ?? row.data);
        if (Number.isNaN(val)) continue;
        if (!latest[dev]) latest[dev] = {};
        const prev = latest[dev][diag.kind];
        if (!prev || String(row.dateTime) > String(prev.ts)) latest[dev][diag.kind] = { val, ts: row.dateTime };
      }
    }

    let updated = 0;
    for (const [dev, info] of Object.entries(latest)) {
      const ignition = info.ignition ? info.ignition.val === 1 : null;
      const engineOn = info.rpm ? info.rpm.val > 0 : null;
      const result = await db.query(
        `UPDATE vehicle_status SET
           ignition_on = COALESCE($2, ignition_on),
           engine_on = COALESCE($3, engine_on),
           status_seen = NOW()
         WHERE device_id = $1`,
        [dev, ignition, engineOn]
      ).catch(() => null);
      if (result && result.rowCount > 0) updated++;
    }
    if (updated > 0) console.log(`[GEOTAB] Ignition/engine status: ${updated} devices updated`);
  } catch (error) {
    console.error('[GEOTAB] Ignition status sync failed:', error.message);
  }
}

// ── Sync: Devices ──

async function syncGeotabDevices() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const fromVersion = lastDeviceVersion === null ? -1 : lastDeviceVersion;
    const feed = await geotabGetFeed(credentials, 'Device', fromVersion);

    if (feed.error) {
      console.error('[GEOTAB] Device feed error:', feed.error.message);
      return;
    }

    const result = feed.result || {};
    const devices = result.data || [];
    if (result.toVersion) lastDeviceVersion = result.toVersion;

    if (devices.length > 0) {
      const enriched = devices.map(d => ({
        id: d.id,
        name: d.name,
        fleet_number: db.extractFleetNumber(d.name),
        license_plate: (d.licensePlate || '').trim() || null,
        device_type: d.deviceType || null,
        vin: d.vehicleIdentificationNumber || null,
        serial_number: d.serialNumber || null,
        fuel_tank_capacity: d.fuelTankCapacity || null,
        timezone: d.timeZoneId || null,
        is_active: !d.activeTo || new Date(d.activeTo) > new Date(),
        active_from: d.activeFrom || null,
        active_to: d.activeTo || null,
        groups: d.groups || [],
        raw_data: d,
      }));
      await db.upsertGeotabDevices(enriched);
      console.log(`[GEOTAB] Synced ${devices.length} devices`);
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync devices:', error.message);
  }
}

// ── Event severity mapping ──

function getSeverity(ruleName) {
  const name = (ruleName || '').toLowerCase();
  if (name.includes('speed')) return 'HIGH';
  if (name.includes('harsh') || name.includes('braking') || name.includes('cornering')) return 'HIGH';
  if (name.includes('crash') || name.includes('impact') || name.includes('fatigue')) return 'CRITICAL';
  if (name.includes('seatbelt')) return 'MEDIUM';
  if (name.includes('idle') || name.includes('idling')) return 'LOW';
  return 'LOW';
}

// ── Sync: Exception Events ──

// Load the persisted feed cursor; falls back to in-memory cursor on first boot.
// NOTE: Geotab feed versions are hex strings (e.g. "0000000056b3e870") - the
// value must NEVER be run through parseFloat, which returns 0 for any hex
// string and would reset the feed to the very beginning on every restart,
// silently re-draining the entire exception-event history (and producing no
// new alerts for a very long time).
async function getEventCursor() {
  if (lastEventVersion !== null && lastEventVersion !== undefined) return lastEventVersion;
  const stored = await getSyncState(SYNC_STATE_EVENT_VERSION);
  if (stored !== null && stored !== undefined) {
    // sync_state.value is a jsonb: a stored string arrives as raw text (hex),
    // a legacy number arrives as a number. Always keep the raw representation.
    lastEventVersion = String(stored).replace(/^["']+|["']+$/g, '') || null;
  }
  return lastEventVersion;
}

// In-flight guard: prevents overlapping pump cycles when processing 50k-record
// pages takes longer than the poll interval.  Without this, multiple concurrent
// syncGeotabEvents calls each capture the same lastEventVersion at the start,
// thrash the cursor, and never print the per-cycle summary (so it appears as if
// no events are being processed).
let eventsSyncInFlight = false;

async function syncGeotabEvents() {
  if (eventsSyncInFlight) {
    console.log('[GEOTAB] ExceptionEvent sync already in flight, skipping cycle');
    return;
  }
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  eventsSyncInFlight = true;
  try {
    const credentials = await geotabAuthenticate(database, username, password);

    // Build a device map once per cycle (avoids a DB hit per event).
    const allDevices = await db.getAllGeotabDevices().catch(() => []);
    const deviceMap = new Map(allDevices.map(d => [d.id, d]));
    console.log(`[GEOTAB] Cached ${deviceMap.size} devices for event processing`);

    // Probe the live head cheaply (GetFeed without fromVersion returns 0
    // records but reports the current max toVersion).  If the persisted cursor
    // is missing, numeric "0", or more than STALE_VERSION_MARGIN behind the
    // head, jump to (head − margin) so the pump fetches only the RECENT tail
    // instead of silently re-draining months of history on restart.
    let fromVersion = null;
    try {
      const headProbe = await geotabGetFeed(credentials, 'ExceptionEvent', null);
      const liveHead = headProbe.result?.toVersion || null;
      const savedCursor = await getEventCursor();
      const cursorLooksStale =
        !savedCursor ||
        savedCursor === '0' ||
        String(savedCursor).replace(/^0+/, '') === '' ||
        (liveHead && !/^[0-9a-f]+$/i.test(savedCursor)) ||
        (liveHead && hexLt(savedCursor, hexSub(liveHead, STALE_VERSION_MARGIN)));

      if (cursorLooksStale && liveHead) {
        const jumpTo = hexSub(liveHead, STALE_VERSION_MARGIN);
        console.log(`[GEOTAB] Cursor is stale/missing (${savedCursor}) — jumping to recent head: ${jumpTo} (live head=${liveHead})`);
        lastEventVersion = jumpTo;
        await setSyncState(SYNC_STATE_EVENT_VERSION, jumpTo);
        fromVersion = jumpTo;
      } else {
        fromVersion = savedCursor;
      }
    } catch {
      // Probe/compare failed — fall back to the persisted cursor as before.
      fromVersion = await getEventCursor();
    }

    let totalInserted = 0;
    let totalUnknownDevice = 0;
    let totalAlerted = 0;
    let pages = 0;

    // Pump the feed until fully drained — NEVER cap and NEVER leave events behind.
    while (pages < MAX_FEED_PUMP_PAGES) {
      pages++;
      const feed = await geotabGetFeed(credentials, 'ExceptionEvent', fromVersion);
      if (feed.error) {
        console.error('[GEOTAB] ExceptionEvent feed error:', feed.error.message);
        break;
      }

      const result = feed.result || {};
      const events = result.data || [];
      const toVersion = result.toVersion;

      if (events.length === 0) {
        // Feed drained; persist cursor so a restart resumes from here.
        if (toVersion !== null && toVersion !== undefined) {
          lastEventVersion = toVersion;
          await setSyncState(SYNC_STATE_EVENT_VERSION, toVersion);
        }
        console.log(`[GEOTAB] ExceptionEvent: feed drained (fromVersion=${fromVersion}, page=${pages})`);
        break;
      }

      console.log(`[GEOTAB] ExceptionEvent: page ${pages} received ${events.length} records (fromVersion=${fromVersion}, toVersion=${toVersion})`);

      const outcome = await processGeotabEventBatch(events, { credentials, deviceMap });
      totalInserted += outcome.inserted;
      totalUnknownDevice += outcome.unknownDevice;
      totalAlerted += outcome.alerted;

      // Only advance the cursor AFTER the full page is processed successfully,
      // so a crash never loses events.
      if (toVersion !== null && toVersion !== undefined && toVersion !== fromVersion) {
        lastEventVersion = toVersion;
        await setSyncState(SYNC_STATE_EVENT_VERSION, toVersion);
        fromVersion = toVersion;
      } else {
        // No new version or unchanged version — we're caught up.
        break;
      }
    }

    console.log(`[GEOTAB] Stored ${totalInserted} telematics events (${totalUnknownDevice} unknown devices, ${totalAlerted} alerts matched)`);
  } catch (error) {
    console.error('[GEOTAB] Failed to sync events:', error.message);
  } finally {
    eventsSyncInFlight = false;
  }
}

async function processGeotabEventBatch(events, { credentials, deviceMap }) {
  let inserted = 0;
  let unknownDevice = 0;
  let alerted = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    try {
      const geotabDeviceId = event.device?.id || '';
      const ruleId = event.rule?.id || '';

      // Device lookup from the in-memory map (no per-event DB hit).
      const device = deviceMap.get(geotabDeviceId) || null;
      let fleetNumber = device?.fleet_number || null;
      let licensePlate = device?.license_plate || null;
      let isUnknownDevice = !device;

      // If fleet_number looks like a Geotab short ID (e.g. "b59"), resolve proper name from vehicle_status
      if (fleetNumber && /^b?[0-9a-f]+$/i.test(fleetNumber) && fleetNumber.length < 10) {
        try {
          const vs = await db.getVehicleStatus(geotabDeviceId);
          if (vs) {
            fleetNumber = vs.fleet_number || fleetNumber;
            licensePlate = vs.license_plate || vs.plate || licensePlate;
          }
        } catch (e) { /* non-critical */ }
      }

      // Resolve human-readable rule name from cache, DB, or Geotab on demand
      const resolvedRuleName = resolveRuleName(credentials, ruleId);
      const eventName = resolvedRuleName || event.rule?.name || ruleId;
      const eventCode = ruleId;
      const severity = getSeverity(eventName);
      const durationSeconds = db.parseDuration(event.duration);
      const distance = typeof event.distance === 'number' ? event.distance : null;

      const driverName = typeof event.driver === 'object' && event.driver?.name
        ? event.driver.name
        : null;

      const diagName = typeof event.diagnostic === 'object' && event.diagnostic?.name
        ? event.diagnostic.name
        : null;

      // Extract zone name from Geotab exception events
      const zoneNameFromEvent = Array.isArray(event.zones) && event.zones.length > 0
        ? event.zones.map(z => z.name).filter(Boolean).join(', ')
        : null;

      let evtLat = event.latitude || null;
      let evtLon = event.longitude || null;
      let evtSpeed = event.speed || null;
      let evtAddress = event.address || null;

      if (!evtLat || !evtLon) {
        const vehiclePos = await db.getVehicleStatus(geotabDeviceId);
        if (vehiclePos) {
          evtLat = evtLat || vehiclePos.latitude;
          evtLon = evtLon || vehiclePos.longitude;
          evtSpeed = evtSpeed || vehiclePos.speed;
        }
      }

      const eventTime = event.activeFrom || event.lastModifiedDateTime || new Date();

      // Store telematics events even for unknown devices — device_id is known,
      // so the event must never be silently dropped.
      const insertResult = await db.query(
        `INSERT INTO telematics_events
         (device_id, vehicle_id, license_plate, fleet_number, plate,
          event_type, event_code, severity, latitude, longitude, speed,
          address, driver_name, description, distance, duration_seconds, zone_name, raw_data, event_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (device_id, event_code, event_time) DO NOTHING
         RETURNING id`,
        [
          geotabDeviceId,
          geotabDeviceId,
          licensePlate,
          fleetNumber,
          fleetNumber,
          eventName,
          eventCode,
          severity,
          evtLat,
          evtLon,
          evtSpeed,
          evtAddress,
          driverName,
          diagName,
          distance,
          durationSeconds,
          zoneNameFromEvent,
          JSON.stringify(event),
          eventTime,
        ]
      );

      if (insertResult.rows.length === 0) {
        // Duplicate (unique index on device+event+time) — nothing new to alert on.
        continue;
      }
      inserted++;
      if (isUnknownDevice) unknownDevice++;

      // Process automatic deduction (NCR = no path) — fire-and-forget so the
      // FOR UPDATE lock in driver_scoring never blocks the ingest loop.
      if (fleetNumber && eventName) {
        processAlertDeduction(fleetNumber, eventName).catch((deductErr) => {
          console.error('[Geotab] Deduction error:', deductErr.message);
        });
      }

      // Dynamically match the Geotab event name against alert_definitions.name
      const { findVehicleCostCenterId } = require('./costCenterLookup');
      const eventCC = await findVehicleCostCenterId(fleetNumber || geotabDeviceId).catch(() => null);
      const telematicsNameMap = await getTelematicsNameMap(eventCC ? [eventCC] : []).catch(() => ({}));
      const matchedDef = matchAlertDefinition(eventName || '', telematicsNameMap.nameMap || {}, telematicsNameMap.signalCodeMap || {}, eventCode || '');

      // Gate: only push telematics events that match an active alert_definition
      if (wsBroadcast && matchedDef && !isUnknownDevice) {
        const row = insertResult.rows[0];
        wsBroadcast('new_event', {
          id: row.id,
          deviceId: geotabDeviceId,
          fleetNumber,
          licensePlate,
          eventType: eventName,
          eventCode,
          severity: String(matchedDef.severity || 'MEDIUM').toUpperCase(),
          latitude: evtLat,
          longitude: evtLon,
          speed: evtSpeed,
          distance,
          durationSeconds,
          driverName,
          description: diagName,
          zoneName: zoneNameFromEvent,
          eventTime: new Date(eventTime).toISOString(),
        });
      }

      if (!matchedDef || isUnknownDevice) {
        continue;
      }

      const alertId = `tel-${geotabDeviceId}-${event.id || `${Date.now()}-${i}`}`;
      const deviceName = fleetNumber ? `${fleetNumber}${licensePlate ? ' - ' + licensePlate : ''}` : geotabDeviceId;

      await db.upsertAlert({
        id: alertId,
        deviceId: geotabDeviceId,
        deviceName,
        alarmType: matchedDef.name,
        alarmTs: eventTime,
        lat: evtLat,
        lon: evtLon,
        alarmText: `${eventName}${zoneNameFromEvent ? ' in zone ' + zoneNameFromEvent : ''}`,
        sourceType: 'telematics',
      });

      const groupRow = await db.upsertAlertGroup({
        deviceId: geotabDeviceId,
        deviceName,
        alarmType: matchedDef.name,
        alarmText: `${eventName}${zoneNameFromEvent ? ' in zone ' + zoneNameFromEvent : ''}`,
        alertId,
        alarmTs: eventTime,
        lat: evtLat,
        lon: evtLon,
        sourceType: 'telematics',
      });
      alerted++;

      if (wsBroadcast) {
        try {
          const alarmText = `${eventName}${zoneNameFromEvent ? ' in zone ' + zoneNameFromEvent : ''}`;
          const groupCount = Number(groupRow?.count || 1) || 1;
          const baseSeverity = String(matchedDef.severity || 'medium').toLowerCase();
          const escalatedSeverity = escalateSeverity(baseSeverity, groupCount);
          // Resolve targets alert_groups.id only — never the tel-/stl- event key.
          const groupId = groupRow?.id != null ? String(groupRow.id) : '';
          if (groupId) {
            wsBroadcast('new-alert', {
              alert: {
                id: groupId,
                alert_id: groupId,
                last_alert_id: alertId,
                alarmId: alertId,
                alarm_id: alertId,
                device_id: geotabDeviceId,
                deviceId: geotabDeviceId,
                vehicleId: geotabDeviceId,
                device_name: deviceName,
                deviceName,
                alert_type: matchedDef.name,
                alarm_type: matchedDef.name,
                type: matchedDef.name,
                title: matchedDef.name,
                alarmText,
                timestamp: new Date(eventTime).toISOString(),
                alarmTs: new Date(eventTime).toISOString(),
                last_occurrence: new Date(eventTime).toISOString(),
                source_type: 'telematics',
                severity: escalatedSeverity,
                priority: escalatedSeverity,
                base_severity: baseSeverity,
                escalated: escalatedSeverity !== baseSeverity,
                status: 'new',
                resolved: false,
                count: groupCount,
                group_key: groupRow?.group_key || `${geotabDeviceId}:${matchedDef.name}`.toLowerCase(),
                lat: evtLat,
                lon: evtLon,
              },
            });
          }
        } catch (_) { /* never block ingest on WS */ }
      }
      console.log(`[GEOTAB] Telematics alert created: ${alertId} group=${groupRow?.id} (${matchedDef.name}) for device ${geotabDeviceId}`);
    } catch (err) {
      // skip individual event errors so one bad event can't stall the batch
    }
  }

  return { inserted, unknownDevice, alerted };
}

// ── Vehicle status from Skycamx (independent of Geotab) ──

const apiClient = require('../helpers/apiClient');

// ── WebSocket broadcast hook (set by websocket.js) ──
let wsBroadcast = null;
function setWsBroadcast(fn) { wsBroadcast = fn; }

// ── Point-in-polygon test (ray casting) ──
function isPointInPolygon(lat, lon, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getZoneAlertLevel(name) {
  const upper = (name || '').toUpperCase();
  if (upper.includes('NO GO')) return 'CRITICAL';
  if (upper.includes('HIGH RISK')) return 'HIGH';
  return 'INFO';
}

// Cache for all zones (refreshed every 5 minutes with syncGeotabZones)
let cachedAllZones = [];
function setCachedAllZones(zones) { cachedAllZones = zones; }

function findCurrentZone(lat, lon) {
  for (const zone of cachedAllZones) {
    let points = zone.points;
    if (typeof points === 'string') {
      try { points = JSON.parse(points); } catch { continue; }
    }
    if (!Array.isArray(points) || points.length < 3) continue;
    if (isPointInPolygon(lat, lon, points)) {
      return { zone_id: zone.id, zone_name: zone.name, is_high_risk: zone.is_high_risk, is_no_go: zone.is_no_go };
    }
  }
  return null;
}

// ── Sync Geotab Zones ──

async function syncGeotabZones() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const response = await geotabFetch({
      method: 'Get',
      params: { typeName: 'Zone', credentials },
      id: 10,
      jsonrpc: '2.0',
    });

    if (response.error) {
      console.error('[GEOTAB] Zone error:', response.error.message);
      return;
    }

    const zones = response.result || [];
    if (zones.length > 0) {
      await db.upsertGeotabZones(zones);
      const highRisk = zones.filter(z => (z.name || '').toUpperCase().includes('HIGH RISK'));
      const noGo = zones.filter(z => (z.name || '').toUpperCase().includes('NO GO'));
      console.log(`[GEOTAB] Synced ${zones.length} zones (${highRisk.length} high risk, ${noGo.length} no go)`);
    }
    // Refresh cached zones for WS enrichment
    const allZones = await db.getGeotabZones();
    setCachedAllZones(allZones);
    invalidateZonesCache();
  } catch (error) {
    console.error('[GEOTAB] Failed to sync zones:', error.message);
  }
}

// ── Sync Log Records (GPS positions) ──

async function syncLogRecords() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    console.log('[GEOTAB] Syncing log records...');
    const credentials = await geotabAuthenticate(database, username, password);
    const fromVersion = lastLogVersion === null ? -1 : lastLogVersion;
    const feed = await geotabGetFeed(credentials, 'LogRecord', fromVersion);

    if (feed.error) {
      console.error('[GEOTAB] LogRecord feed error:', feed.error.message);
      return;
    }

    const result = feed.result || {};
    const records = result.data || [];
    if (result.toVersion) lastLogVersion = result.toVersion;

    // On first load, process records but only keep latest per device for vehicle_status
    if (fromVersion === -1) {
      const latestPerDevice = new Map();
      for (const rec of records) {
        const deviceId = rec.device?.id || '';
        if (!deviceId || !rec.latitude || !rec.longitude) continue;
        const existing = latestPerDevice.get(deviceId);
        if (!existing || new Date(rec.dateTime) > new Date(existing.dateTime)) {
          latestPerDevice.set(deviceId, rec);
        }
      }
      // Update vehicle_status with latest positions
      for (const [deviceId, rec] of latestPerDevice) {
        const geotabDevice = await db.getGeotabDevice(deviceId);
        await db.upsertVehicleStatus(deviceId, {
          plate: geotabDevice?.name || null,
          licensePlate: geotabDevice?.license_plate || null,
          fleetNumber: geotabDevice?.fleet_number || null,
          speed: rec.speed,
          latitude: rec.latitude,
          longitude: rec.longitude,
          lastLogTime: rec.dateTime,
        });

        // Broadcast position update to fleet map
        if (wsBroadcast && rec.latitude && rec.longitude) {
          const currentZone = findCurrentZone(rec.latitude, rec.longitude);
          wsBroadcast('vehicle_position', {
            device_id: deviceId,
            plate: geotabDevice?.name || null,
            license_plate: geotabDevice?.license_plate || null,
            fleet_number: geotabDevice?.fleet_number || null,
            speed: rec.speed,
            latitude: rec.latitude,
            longitude: rec.longitude,
            last_log_time: rec.dateTime,
            current_zone: currentZone,
          });
        }
      }
      console.log(`[GEOTAB] LogRecord: initialized version cursor, updated ${latestPerDevice.size} vehicle positions from ${records.length} historical records`);
      return;
    }

    if (records.length === 0) {
      console.log(`[GEOTAB] LogRecord feed: 0 records (fromVersion=${fromVersion})`);
      return;
    }

    // Get today's midnight for filtering
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const logRecords = [];
    const statusUpdates = new Map();

    for (const rec of records) {
      const deviceId = rec.device?.id || '';
      if (!deviceId) continue;

      const recTime = new Date(rec.dateTime);
      if (recTime < today) continue; // Only store today's records

      logRecords.push({
        deviceId,
        latitude: rec.latitude || null,
        longitude: rec.longitude || null,
        speed: rec.speed || null,
        heading: rec.heading || null,
        odometer: rec.odometer || null,
        recordTime: rec.dateTime,
      });

      // Keep latest record per device for vehicle_status update
      const existing = statusUpdates.get(deviceId);
      if (!existing || recTime > new Date(existing.recordTime)) {
        statusUpdates.set(deviceId, {
          latitude: rec.latitude,
          longitude: rec.longitude,
          speed: rec.speed,
          recordTime: rec.dateTime,
        });
      }
    }

    // Store log records
    if (logRecords.length > 0) {
      await db.upsertVehicleLogRecords(logRecords);
      console.log(`[GEOTAB] Stored ${logRecords.length} log records`);
    }

    // Update vehicle_status with latest positions
    for (const [deviceId, data] of statusUpdates) {
      const geotabDevice = await db.getGeotabDevice(deviceId);
      const fleetNumber = geotabDevice?.fleet_number || null;
      const licensePlate = geotabDevice?.license_plate || null;

      await db.upsertVehicleStatus(deviceId, {
        plate: geotabDevice?.name || null,
        licensePlate,
        fleetNumber,
        speed: data.speed,
        latitude: data.latitude,
        longitude: data.longitude,
        lastLogTime: data.recordTime,
      });

      // Broadcast position update to fleet map
      if (wsBroadcast && data.latitude && data.longitude) {
        const currentZone = findCurrentZone(data.latitude, data.longitude);
        wsBroadcast('vehicle_position', {
          device_id: deviceId,
          plate: geotabDevice?.name || null,
          license_plate: licensePlate,
          fleet_number: fleetNumber,
          speed: data.speed,
          latitude: data.latitude,
          longitude: data.longitude,
          last_log_time: data.recordTime,
          current_zone: currentZone,
        });
      }

      // Check zone breaches
      if (data.latitude && data.longitude) {
        await checkZoneBreaches(deviceId, data.latitude, data.longitude, data.speed, fleetNumber, licensePlate);
      }
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync log records:', error.message);
  }
}

// ── Zone Breach Detection ──

// Geotab rule id for "Entering High Risk Area" — used to detect whether the
// Geotab exception feed already covered a zone entry we detected ourselves.
const GEOTAB_ENTERING_HIGH_RISK_CODE = 'aCmnsH92P1kqGBTWyRmdacA';
const ZONE_ENTRY_DEDUP_WINDOW_MS = 2 * 60 * 1000;

// Fallback alert creation for zone entries detected by our own polygon check.
// Only fires when Geotab did NOT already send the same zone-entry event within
// ±2 min of the detected entry; if Geotab's event arrives later it merges into
// this same group (same device + alarm_type + source) — one card either way.
async function createZoneEntryAlert({ deviceId, fleetNumber, licensePlate, lat, lon, speed, zone, entryTime }) {
  try {
    const isNoGo = !!zone.is_no_go;
    const defName = isNoGo ? 'No-Go Zone Entry' : 'Entering High Risk Area';

    if (!isNoGo) {
      const entryMs = new Date(entryTime).getTime();
      const dup = await db.query(
        `SELECT 1 FROM telematics_events
         WHERE device_id = $1 AND event_code = $2
           AND event_time >= $3::timestamptz
           AND event_time <= $4::timestamptz
         LIMIT 1`,
        [deviceId, GEOTAB_ENTERING_HIGH_RISK_CODE,
         new Date(entryMs - ZONE_ENTRY_DEDUP_WINDOW_MS).toISOString(),
         new Date(entryMs + ZONE_ENTRY_DEDUP_WINDOW_MS).toISOString()]
      );
      if (dup.rows.length > 0) return null; // Geotab already covered it
    }

    const { findVehicleCostCenterId } = require('./costCenterLookup');
    const eventCC = await findVehicleCostCenterId(fleetNumber || deviceId).catch(() => null);
    const nameMap = await getTelematicsNameMap(eventCC ? [eventCC] : []).catch(() => ({}));
    const matchedDef = (nameMap.nameMap || {})[defName.toLowerCase()];
    if (!matchedDef) return null; // not in this device's CC set — would be filtered from display anyway

    const alertId = `zone-${deviceId}-${zone.id}-${Date.now()}`;
    const deviceName = fleetNumber ? `${fleetNumber}${licensePlate ? ' - ' + licensePlate : ''}` : deviceId;
    const alarmText = `${defName} in zone ${zone.name}`;

    await db.upsertAlert({
      id: alertId,
      deviceId,
      deviceName,
      alarmType: matchedDef.name,
      alarmTs: entryTime,
      lat,
      lon,
      alarmText,
      sourceType: 'telematics',
    });

    const groupRow = await db.upsertAlertGroup({
      deviceId,
      deviceName,
      alarmType: matchedDef.name,
      alarmText,
      alertId,
      alarmTs: entryTime,
      lat,
      lon,
      sourceType: 'telematics',
    });
    if (!groupRow || groupRow.id == null) return null;

    if (wsBroadcast) {
      try {
        const groupCount = Number(groupRow.count || 1) || 1;
        const baseSeverity = String(matchedDef.severity || 'medium').toLowerCase();
        const escalatedSeverity = escalateSeverity(baseSeverity, groupCount);
        const groupId = String(groupRow.id);
        wsBroadcast('new-alert', {
          alert: {
            id: groupId,
            alert_id: groupId,
            last_alert_id: alertId,
            alarmId: alertId,
            alarm_id: alertId,
            device_id: deviceId,
            deviceId,
            vehicleId: deviceId,
            device_name: deviceName,
            deviceName,
            alert_type: matchedDef.name,
            alarm_type: matchedDef.name,
            type: matchedDef.name,
            title: matchedDef.name,
            alarmText,
            timestamp: new Date(entryTime).toISOString(),
            alarmTs: new Date(entryTime).toISOString(),
            last_occurrence: new Date(entryTime).toISOString(),
            source_type: 'telematics',
            severity: escalatedSeverity,
            priority: escalatedSeverity,
            base_severity: baseSeverity,
            escalated: escalatedSeverity !== baseSeverity,
            status: 'new',
            resolved: false,
            count: groupCount,
            group_key: groupRow.group_key || `${deviceId}:${matchedDef.name}`.toLowerCase(),
            lat,
            lon,
          },
        });
      } catch (_) { /* never block zone check on WS */ }
    }
    console.log(`[GEOTAB] Zone alert created: ${alertId} group=${groupRow.id} (${matchedDef.name}) for ${fleetNumber || deviceId} in ${zone.name}`);
    return groupRow;
  } catch (error) {
    console.error('[GEOTAB] Zone entry alert failed:', error.message);
    return null;
  }
}

async function checkZoneBreaches(deviceId, lat, lon, speed, fleetNumber, licensePlate) {
  try {
    let zones = zonesCache.data;
    if (!zones || Date.now() - zonesCache.ts > ZONES_CACHE_TTL) {
      zones = await db.getHighRiskZones();
      zonesCache = { data: zones, ts: Date.now() };
    }

    const cachedEntry = activeEntriesCache.get(deviceId);
    let activeEntries;
    if (cachedEntry && Date.now() - cachedEntry.ts <= ACTIVE_ENTRIES_CACHE_TTL) {
      activeEntries = cachedEntry.data;
    } else {
      activeEntries = await db.getActiveZoneEntries(deviceId);
      activeEntriesCache.set(deviceId, { data: activeEntries, ts: Date.now() });
    }
    const activeZoneIds = new Set(activeEntries.map(e => e.zone_id));

    for (const zone of zones) {
      let points = zone.points;
      if (typeof points === 'string') {
        try { points = JSON.parse(points); } catch { continue; }
      }
      if (!Array.isArray(points) || points.length < 3) continue;

      const isInside = isPointInPolygon(lat, lon, points);
      const wasInside = activeZoneIds.has(zone.id);

      if (isInside && !wasInside) {
        // Vehicle entered zone
        const riskLevel = zone.is_no_go ? 'CRITICAL' : 'HIGH';
        const entry = await db.insertZoneEntry({
          deviceId,
          fleetNumber,
          licensePlate,
          zoneId: zone.id,
          zoneName: zone.name,
          riskLevel,
          latitude: lat,
          longitude: lon,
          speed,
          entryTime: new Date().toISOString(),
        });

        console.log(`[GEOTAB] Zone breach: ${fleetNumber || deviceId} entered ${zone.name} (${riskLevel})`);

        // Broadcast via WebSocket
        if (wsBroadcast && entry) {
          wsBroadcast('zone_breach', {
            id: entry.id,
            deviceId,
            fleetNumber,
            licensePlate,
            zoneId: zone.id,
            zoneName: zone.name,
            riskLevel,
            latitude: lat,
            longitude: lon,
            speed,
            entryTime: new Date().toISOString(),
          });
        }

        // Fallback alert card — only when Geotab didn't already send the same
        // zone-entry event within ±2 min (then Geotab's alert is the one stored).
        await createZoneEntryAlert({
          deviceId,
          fleetNumber,
          licensePlate,
          lat,
          lon,
          speed,
          zone,
          entryTime: new Date().toISOString(),
        });
      } else if (!isInside && wasInside) {
        // Vehicle exited zone — mark as inactive
        const existing = activeEntries.find(e => e.zone_id === zone.id);
        if (existing) {
          await db.query(
            'UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = NOW() WHERE id = $1',
            [existing.id]
          );
        }
      }
    }
  } catch (error) {
    console.error('[GEOTAB] Zone breach check failed:', error.message);
  }
}

async function fetchAndStoreVehicleStatus() {
  try {
    const response = await apiClient.makeRequest('/device/page', {
      pageSize: 200, pageIndex: 1, subsumption: true,
    }, 15000);

    if (response.code !== 0 || !response.data?.records) return;

    const records = response.data.records;

    let updated = 0;
    for (const record of records) {
      try {
        const geotabDevice = await db.getGeotabDevice(record.id);
        const fleetNumber = geotabDevice?.fleet_number || null;
        const licensePlate = geotabDevice?.license_plate || null;

        // Real Geotab ignition/RPM (syncIgnitionStatus) when the last StatusData
        // sample is fresh (<=5 min); otherwise fall back to the legacy
        // speed >= 5 heuristic. Also guards against clobbering fresh real values.
        const prevResult = await db.query(
          'SELECT engine_on, ignition_on, speed, status_seen FROM vehicle_status WHERE device_id = $1',
          [record.id]
        );
        const prevRow = prevResult.rows[0] || {};
        const wasEngineOn = prevRow.engine_on || false;
        const currentSpeed = prevRow.speed || 0;
        const statusFresh =
          prevRow.status_seen &&
          Date.now() - new Date(prevRow.status_seen).getTime() <= 5 * 60 * 1000;
        const isEngineOn = statusFresh ? !!prevRow.engine_on : currentSpeed >= 5;
        const isIgnitionOn = statusFresh ? !!prevRow.ignition_on : currentSpeed >= 5;

        await db.query(
          `INSERT INTO vehicle_status (device_id, plate, license_plate, fleet_number, engine_on, ignition_on, last_update)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (device_id) DO UPDATE SET
             plate = COALESCE(EXCLUDED.plate, vehicle_status.plate),
             license_plate = COALESCE(EXCLUDED.license_plate, vehicle_status.license_plate),
             fleet_number = COALESCE(EXCLUDED.fleet_number, vehicle_status.fleet_number),
             engine_on = $5, ignition_on = $6, last_update = NOW()`,
          [record.id, record.deviceName || null, licensePlate, fleetNumber, isEngineOn, isIgnitionOn]
        );

        // RTMS: Log engine on/off transitions
        try {
          if (isEngineOn && !wasEngineOn) {
            const { query: rtmsQuery } = require('../db');
            const { findVehicleCostCenterId } = require('./costCenterLookup');
            const sessionCC = await findVehicleCostCenterId(fleetNumber || record.id);
            await rtmsQuery(
              'INSERT INTO rtms_driving_sessions (device_id, fleet_number, registration_number, engine_on_at, cost_center_id) VALUES ($1, $2, $3, NOW(), $4)',
              [record.id, fleetNumber, licensePlate, sessionCC]
            );
          } else if (!isEngineOn && wasEngineOn) {
            const { query: rtmsQuery } = require('../db');
            await rtmsQuery(
              "UPDATE rtms_driving_sessions SET engine_off_at = NOW() WHERE device_id = $1 AND engine_off_at IS NULL",
              [record.id]
            );
          }
        } catch (rtmsErr) {
          // silent fail for RTMS logging
        }

        updated++;
      } catch (err) {
        // skip
      }
    }
    if (updated > 0) console.log(`[GEOTAB] Updated ${updated} vehicle statuses`);
  } catch (error) {
    console.error('[GEOTAB] Failed to fetch vehicle status:', error.message);
  }
}

// ── Polling control ──

async function initialSync() {
  console.log('[GEOTAB] Starting initial sync...');
  await syncGeotabGroups();
  await syncGeotabExceptionRules();
  await loadRuleNameCache();
  await syncGeotabDiagnostics();
  await syncGeotabDevices();
  await syncGeotabZones();
  console.log('[GEOTAB] Initial sync complete');
}

function startPolling(intervalMs = 60000, eventIntervalMs = 15000) {
  if (pollingInterval) clearInterval(pollingInterval);
  if (eventPollingInterval) clearInterval(eventPollingInterval);

  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;

  if (!database || !username || !password) {
    console.log('[GEOTAB] Credentials not configured. Set GEOTAB_DATABASE, GEOTAB_USERNAME, GEOTAB_PASSWORD in .env');
    return;
  }

  initialSync().then(() => {
    fetchAndStoreEvents();
    fetchAndStoreVehicleStatus();
    syncLogRecords();
    syncDeviceStatus();
    syncIgnitionStatus();

    pollingInterval = setInterval(async () => {
      await syncGeotabGroups();
      await syncGeotabExceptionRules();
      await syncGeotabDiagnostics();
      await syncGeotabDevices();
      await syncGeotabZones();
      await syncLogRecords();
      await syncDeviceStatus();
      await syncIgnitionStatus();
      await fetchAndStoreVehicleStatus();
    }, intervalMs);

    // Exception events are the time-critical feed — poll frequently so new
    // telematics alerts arrive as they happen. The in-flight guard prevents
    // overlapping cycles when a batch is still being processed.
    eventPollingInterval = setInterval(async () => {
      await syncGeotabEvents();
    }, eventIntervalMs);

    // Sync zones less frequently (every 5 minutes)
    setInterval(async () => {
      await syncGeotabZones();
    }, 5 * 60 * 1000);

    console.log(`[GEOTAB] Polling started: metadata every ${intervalMs / 1000}s, events every ${eventIntervalMs / 1000}s`);
  });
}

async function fetchAndStoreEvents() {
  await syncGeotabEvents();
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (eventPollingInterval) {
    clearInterval(eventPollingInterval);
    eventPollingInterval = null;
  }
}

module.exports = { startPolling, stopPolling, syncGeotabEvents, initialSync, setWsBroadcast, syncNewFleetVehicles, checkZoneBreaches };
