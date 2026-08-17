const db = require('../db');
const https = require('https');
const { fetchVehiclesFromSupabase } = require('../helpers/supabaseClient');

const GEOTAB_URL = 'https://my.geotab.com/apiv1';

// ── Module state ──

let pollingInterval = null;
let cachedCredentials = null;
let credentialsExpiry = null;

let lastDeviceVersion = null;
let lastEventVersion = null;

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
  return geotabFetch({
    method: 'GetFeed',
    params: { typeName, fromVersion, credentials },
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

function geotabMultiCall(credentials, calls) {
  return geotabFetch({
    method: 'MultiCall',
    params: { calls, credentials },
    id: 10,
    jsonrpc: '2.0',
  });
}

// ── Sync: Fleet Vehicles from Supabase ──

async function syncFleetVehicles() {
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
    })).filter(v => v.fleet_number || v.registration_number);

    await db.upsertFleetVehicles(enriched);
    console.log(`[FLEET] Synced ${enriched.length} vehicles from Supabase`);
  } catch (error) {
    console.error('[FLEET] Failed to sync fleet vehicles:', error.message);
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
    const feed = await geotabMultiCall(credentials, [
      { method: 'Get', params: { typeName: 'Group' } },
    ]);

    if (feed.error) {
      console.error('[GEOTAB] Group error:', feed.error.message);
      return;
    }

    const results = feed.result || [];
    const groups = (Array.isArray(results) && results.length > 0) ? results[0] : [];

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
    } else {
      console.log('[GEOTAB] No groups returned from MultiCall');
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
    const feed = await geotabMultiCall(credentials, [
      { method: 'Get', params: { typeName: 'ExceptionRule' } },
    ]);

    if (feed.error) {
      console.error('[GEOTAB] ExceptionRule error:', feed.error.message);
      return;
    }

    const results = feed.result || [];
    const rules = (Array.isArray(results) && results.length > 0) ? results[0] : [];

    if (rules.length > 0) {
      const enriched = rules.map(r => ({
        id: r.id,
        name: r.name || r.id,
        description: r.description || null,
        raw_data: r,
      }));
      await db.upsertExceptionRules(enriched);
      console.log(`[GEOTAB] Synced ${rules.length} exception rules`);
    } else {
      console.log('[GEOTAB] No exception rules returned from MultiCall');
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync exception rules:', error.message);
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
    const feed = await geotabMultiCall(credentials, [
      { method: 'Get', params: { typeName: 'Diagnostic' } },
    ]);

    if (feed.error) {
      console.error('[GEOTAB] Diagnostic error:', feed.error.message);
      return;
    }

    const results = feed.result || [];
    const diagnostics = (Array.isArray(results) && results.length > 0) ? results[0] : [];

    if (diagnostics.length > 0) {
      const enriched = diagnostics.map(d => ({
        id: d.id,
        name: d.name || d.id,
        unit: d.unit || null,
        raw_data: d,
      }));
      await db.upsertDiagnostics(enriched);
      console.log(`[GEOTAB] Synced ${diagnostics.length} diagnostics`);
    } else {
      console.log('[GEOTAB] No diagnostics returned from MultiCall');
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync diagnostics:', error.message);
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

async function syncGeotabEvents() {
  const database = process.env.GEOTAB_DATABASE;
  const username = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !username || !password) return;

  try {
    const credentials = await geotabAuthenticate(database, username, password);
    const fromVersion = lastEventVersion === null ? -1 : lastEventVersion;
    const feed = await geotabGetFeed(credentials, 'ExceptionEvent', fromVersion);

    if (feed.error) {
      console.error('[GEOTAB] ExceptionEvent feed error:', feed.error.message);
      return;
    }

    const result = feed.result || {};
    const events = result.data || [];
    if (result.toVersion) lastEventVersion = result.toVersion;

    if (events.length === 0) return;

    let inserted = 0;
    let skipped = 0;
    for (const event of events) {
      try {
        const geotabDeviceId = event.device?.id || '';
        const ruleId = event.rule?.id || '';
        const diagnosticId = event.diagnostic?.id || null;

        const device = await db.getGeotabDevice(geotabDeviceId);
        const rule = await db.getExceptionRule(ruleId);
        const diagnostic = diagnosticId ? await db.getDiagnostic(diagnosticId) : null;

        const fleetNumber = device?.fleet_number || null;
        const licensePlate = device?.license_plate || null;

        // Filter: only store events for fleet vehicles
        if (fleetNumber || licensePlate) {
          const isFleet = await db.isFleetVehicle(fleetNumber, licensePlate);
          if (!isFleet) {
            skipped++;
            continue;
          }
        }

        const eventName = rule?.name || ruleId;
        const eventCode = ruleId;
        const severity = getSeverity(eventName);
        const durationSeconds = db.parseDuration(event.duration);

        const driverName = typeof event.driver === 'object' && event.driver?.name
          ? event.driver.name
          : null;

        await db.query(
          `INSERT INTO telematics_events
           (device_id, vehicle_id, license_plate, fleet_number, plate,
            event_type, event_code, severity, latitude, longitude, speed,
            address, driver_name, description, raw_data, event_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT DO NOTHING`,
          [
            geotabDeviceId,
            geotabDeviceId,
            licensePlate,
            fleetNumber,
            fleetNumber,
            eventName,
            eventCode,
            severity,
            event.latitude || null,
            event.longitude || null,
            event.speed || null,
            event.address || null,
            driverName,
            diagnostic?.name || null,
            JSON.stringify(event),
            event.activeFrom || event.lastModifiedDateTime || new Date(),
          ]
        );
        inserted++;
      } catch (err) {
        // skip individual event errors
      }
    }

    if (inserted > 0 || skipped > 0) {
      console.log(`[GEOTAB] Stored ${inserted} telematics events (${skipped} skipped - not fleet)`);
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync events:', error.message);
  }
}

// ── Vehicle status from Skycamx (independent of Geotab) ──

const apiClient = require('../helpers/apiClient');

async function fetchAndStoreVehicleStatus() {
  try {
    const response = await apiClient.makeRequest('/device/page', {
      pageSize: 200, pageIndex: 1, subsumption: true,
    }, 15000);

    if (response.code !== 0 || !response.data?.records) return;

    const records = response.data.records;

    const recentAlerts = await db.query(
      `SELECT DISTINCT device_id FROM alerts WHERE alarm_ts > NOW() - INTERVAL '10 minutes'`
    );
    const onlineDevices = new Set(recentAlerts.rows.map(r => r.device_id));

    let updated = 0;
    for (const record of records) {
      try {
        const isOnline = onlineDevices.has(record.id);

        const geotabDevice = await db.getGeotabDevice(record.id);
        const fleetNumber = geotabDevice?.fleet_number || null;
        const licensePlate = geotabDevice?.license_plate || null;

        await db.query(
          `INSERT INTO vehicle_status (device_id, plate, license_plate, fleet_number, engine_on, ignition_on, last_update)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (device_id) DO UPDATE SET
             plate = COALESCE(EXCLUDED.plate, vehicle_status.plate),
             license_plate = COALESCE(EXCLUDED.license_plate, vehicle_status.license_plate),
             fleet_number = COALESCE(EXCLUDED.fleet_number, vehicle_status.fleet_number),
             engine_on = $5, ignition_on = $6, last_update = NOW()`,
          [record.id, record.deviceName || null, licensePlate, fleetNumber, isOnline, isOnline]
        );
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
  await syncFleetVehicles();
  await syncGeotabGroups();
  await syncGeotabExceptionRules();
  await syncGeotabDiagnostics();
  await syncGeotabDevices();
  console.log('[GEOTAB] Initial sync complete');
}

function startPolling(intervalMs = 60000) {
  if (pollingInterval) clearInterval(pollingInterval);

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

    pollingInterval = setInterval(async () => {
      await syncFleetVehicles();
      await syncGeotabGroups();
      await syncGeotabExceptionRules();
      await syncGeotabDiagnostics();
      await syncGeotabDevices();
      await syncGeotabEvents();
      await fetchAndStoreVehicleStatus();
    }, intervalMs);

    console.log(`[GEOTAB] Polling started every ${intervalMs / 1000}s`);
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
}

module.exports = { startPolling, stopPolling, syncGeotabEvents, initialSync };
