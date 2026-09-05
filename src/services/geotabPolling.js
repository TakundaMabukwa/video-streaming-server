const db = require('../db');
const https = require('https');
const { fetchVehiclesFromSupabase } = require('../helpers/supabaseClient');
const { getTelematicsNameMap } = require('../db/alert_definitions');
const { matchAlertDefinition } = require('../helpers/alertMatching');
const { processAlertDeduction } = require('./driverScoringService');

const GEOTAB_URL = 'https://my.geotab.com/apiv1';

// ── Module state ──

let pollingInterval = null;
let cachedCredentials = null;
let credentialsExpiry = null;

let lastDeviceVersion = null;
let lastEventVersion = null;
let lastDiagnosticsVersion = null;
let lastLogVersion = null;

// In-memory cache of Geotab rule names keyed by rule id
const ruleNameCache = new Map();

function getRuleName(ruleId) {
  if (!ruleId) return null;
  if (ruleNameCache.has(ruleId)) return ruleNameCache.get(ruleId);
  return ruleId;
}

async function resolveRuleName(credentials, ruleId) {
  if (!ruleId || ruleNameCache.has(ruleId)) return getRuleName(ruleId);
  try {
    const response = await geotabGetById(credentials, 'Rule', ruleId);
    if (response.error) return ruleId;
    const rules = response.result || [];
    const rule = rules.find((r) => r.id === ruleId);
    if (rule?.name) {
      ruleNameCache.set(ruleId, rule.name);
      // Also persist to DB asynchronously (fire-and-forget)
      db.upsertExceptionRules([{
        id: rule.id,
        name: rule.name,
        description: rule.description || null,
        raw_data: rule,
      }]).catch(() => {});
      return rule.name;
    }
  } catch {}
  return ruleId;
}

// Prevent feed backlogs from overwhelming the DB on a single poll cycle
const MAX_EVENTS_PER_POLL = 1000;
const MAX_DIAGNOSTICS_PER_POLL = 5000;

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
    })).filter(v => v.fleet_number || v.registration_number);

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
    // Use null for first call; Geotab returns only new records and a toVersion cursor
    const feed = await geotabGetFeed(credentials, 'ExceptionEvent', lastEventVersion);

    if (feed.error) {
      console.error('[GEOTAB] ExceptionEvent feed error:', feed.error.message);
      return;
    }

    const result = feed.result || {};
    let events = result.data || [];
    if (result.toVersion) lastEventVersion = result.toVersion;

    if (events.length === 0) {
      if (lastEventVersion === null) {
        console.log('[GEOTAB] ExceptionEvent: no new records, cursor not yet set');
      }
      return;
    }

    console.log(`[GEOTAB] ExceptionEvent: received ${events.length} new records`);

    // Cap per-cycle processing to protect the DB from large backlogs
    let dropped = 0;
    if (events.length > MAX_EVENTS_PER_POLL) {
      dropped = events.length - MAX_EVENTS_PER_POLL;
      // Keep the most recent events (real-time dashboard only cares about recent ones)
      events = events
        .slice()
        .sort((a, b) => new Date(b.activeFrom || b.lastModifiedDateTime || 0) - new Date(a.activeFrom || a.lastModifiedDateTime || 0))
        .slice(0, MAX_EVENTS_PER_POLL);
    }

    let inserted = 0;
    let skipped = 0;
    for (const event of events) {
      try {
        const geotabDeviceId = event.device?.id || '';
        const ruleId = event.rule?.id || '';

        // Filter: only store events for devices we know about
        const device = await db.getGeotabDevice(geotabDeviceId);
        if (!device) {
          skipped++;
          continue;
        }
        let fleetNumber = device?.fleet_number || null;
        let licensePlate = device?.license_plate || null;

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
        const resolvedRuleName = await resolveRuleName(credentials, ruleId);
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

        const insertResult = await db.query(
          `INSERT INTO telematics_events
           (device_id, vehicle_id, license_plate, fleet_number, plate,
            event_type, event_code, severity, latitude, longitude, speed,
            address, driver_name, description, distance, duration_seconds, zone_name, raw_data, event_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT DO NOTHING
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
        inserted++;

        // Process automatic deduction (NCR = no path)
        if (fleetNumber && eventName) {
          try {
            await processAlertDeduction(fleetNumber, eventName);
          } catch (deductErr) {
            console.error('[Geotab] Deduction error:', deductErr.message);
          }
        }

        // Also store as alert in alerts + alert_groups tables (telematics source)
        // Dynamically match the Geotab event name against alert_definitions.name
        const { findVehicleCostCenterId } = require('./costCenterLookup');
        const eventCC = await findVehicleCostCenterId(fleetNumber || geotabDeviceId).catch(() => null);
        const telematicsNameMap = await getTelematicsNameMap(eventCC ? [eventCC] : []).catch(() => ({}));
        const matchedDef = matchAlertDefinition(eventName || '', telematicsNameMap);

        // Gate: only push telematics events that match an active alert_definition
        if (wsBroadcast && insertResult.rows.length > 0 && matchedDef) {
          const row = insertResult.rows[0];
          wsBroadcast('new_event', {
            id: row.id,
            deviceId: geotabDeviceId,
            fleetNumber,
            licensePlate,
            eventType: eventName,
            eventCode,
            severity: matchedDef.severity.toUpperCase(),
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

        try {
          if (!matchedDef) {
            continue;
          }

          const alertId = `tel-${geotabDeviceId}-${Date.now()}-${inserted}`;
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

          await db.upsertAlertGroup({
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
          console.log(`[GEOTAB] Telematics alert created: ${alertId} (${matchedDef.name}) for device ${geotabDeviceId}`);
        } catch (alertErr) {
          console.error('[GEOTAB] Failed to create telematics alert:', alertErr.message, alertErr.stack);
        }
      } catch (err) {
        // skip individual event errors
      }
    }

    if (inserted > 0 || skipped > 0 || dropped > 0) {
      console.log(`[GEOTAB] Stored ${inserted} telematics events (${skipped} skipped - not fleet${dropped > 0 ? `, ${dropped} dropped - backlog limit` : ''})`);
    }
  } catch (error) {
    console.error('[GEOTAB] Failed to sync events:', error.message);
  }
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

async function checkZoneBreaches(deviceId, lat, lon, speed, fleetNumber, licensePlate) {
  try {
    const zones = await db.getHighRiskZones();
    const activeEntries = await db.getActiveZoneEntries(deviceId);
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

        // Get current speed from vehicle_status (set by syncDeviceStatus from Geotab)
        const prevResult = await db.query('SELECT engine_on, speed FROM vehicle_status WHERE device_id = $1', [record.id]);
        const wasEngineOn = prevResult.rows.length > 0 ? (prevResult.rows[0].engine_on || false) : false;
        const currentSpeed = prevResult.rows.length > 0 ? (prevResult.rows[0].speed || 0) : 0;
        const isEngineOn = currentSpeed >= 5;

        await db.query(
          `INSERT INTO vehicle_status (device_id, plate, license_plate, fleet_number, engine_on, ignition_on, last_update)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (device_id) DO UPDATE SET
             plate = COALESCE(EXCLUDED.plate, vehicle_status.plate),
             license_plate = COALESCE(EXCLUDED.license_plate, vehicle_status.license_plate),
             fleet_number = COALESCE(EXCLUDED.fleet_number, vehicle_status.fleet_number),
             engine_on = $5, ignition_on = $6, last_update = NOW()`,
          [record.id, record.deviceName || null, licensePlate, fleetNumber, isEngineOn, isEngineOn]
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
    syncLogRecords();
    syncDeviceStatus();

    pollingInterval = setInterval(async () => {
      await syncGeotabGroups();
      await syncGeotabExceptionRules();
      await syncGeotabDiagnostics();
      await syncGeotabDevices();
      await syncGeotabEvents();
      await syncGeotabZones();
      await syncLogRecords();
      await syncDeviceStatus();
      await fetchAndStoreVehicleStatus();
    }, intervalMs);

    // Sync zones less frequently (every 5 minutes)
    setInterval(async () => {
      await syncGeotabZones();
    }, 5 * 60 * 1000);

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

module.exports = { startPolling, stopPolling, syncGeotabEvents, initialSync, setWsBroadcast, syncNewFleetVehicles, checkZoneBreaches };
