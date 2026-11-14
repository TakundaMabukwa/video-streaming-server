const https = require('https');
const db = require('../db');
const turf = require('@turf/turf');
const { findVehicleCostCenterId, resolveFleetNumber, normalizeFleetString } = require('./costCenterLookup');
const { isAlertActiveForCC } = require('../db/alert_definitions');
const { isRegisteredVehicle } = require('./fleetRegistryGuard');
const { escalateSeverity } = require('../helpers/transform');
const { categoryOf, entryLabel, riskLevel, stopSignalCodes } = require('../alerts/zoneCategory');
const sseHub = require('../live/sseHub');
const zoneNotifications = require('./zoneNotifications');
const {
  FATIGUE_3H_CODE,
  FATIGUE_6H_CODE,
  FATIGUE_9H_CODE,
  DURATION_8H_CODE,
  DURATION_12H_CODE,
  DURATION_15H_CODE,
  SPEED_85_CODE,
  SPEED_90_CODE,
  ZONE_ENTRY_CODE,
  NOGO_ENTRY_CODE,
  NO_STOP_ENTRY_CODE,
  ZONE_APPROACHING_CODE,
  SIGNAL_LOSS_ENTRY_CODE,
  isSelfMonitoringZoneAlert,
  ZONE_STOP_IMMEDIATE_CODE,
  ZONE_STOP_1MIN_HIGH_CODE,
  ZONE_STOP_1MIN_NO_CODE,
} = require('../helpers/pollerOwnedAlerts');

const GEOTAB_URL = 'https://my.geotab.com/apiv1';
const POLL_INTERVAL_MS = 15000;

// Speed-cutoff(s) for "stopped" zone logic (km/h). High-risk zones flag a stop
// immediately at the tight threshold; No-Stopping zones require speed < 10.
const STOP_SPEED = 5;
const STOP_SPEED_NO_STOPPING = 10;
const ZONES_CACHE_TTL = 5 * 60 * 1000;
const META_CACHE_TTL = 60 * 1000;
const telemetryFleetMissLogged = new Set();
let telemetrySequence = 0;

// Freshness gate: a vehicle only counts as live when Geotab reports it as
// currently communicating AND its own event time (dateTime) is recent. Anything
// older than this is last-known data and must not drive alerts.
const DATA_FRESH_MS = 5 * 60 * 1000;
// Speed episode re-arm dwell: after a speed alert fires, the vehicle must stay
// below the threshold for ~30s (≈2 polls) before the alert can fire again.
const SPEED_REARM_DWELL_MS = 30 * 1000;
// 85 km/h must be sustained for >= 2 minutes before it flags (matches Geotab's
// own 85 rule: smallest episode it ever produced is exactly 120s; Geotab
// reports the 85 cutoff as 86, so the episode uses speed >= 86). 90 km/h is
// unchanged — a single fresh sample at/above 90 flags immediately.
const SPEED_85_SUSTAIN_MS = 120 * 1000;
// A held fatigue/duration threshold only re-arms after a REAL break. Geotab's
// clock restarts on any state change — a 4-minute robot/fuel stop used to look
// like a "genuine new run" and re-fired the 3h batch in the same shift (EX65:
// fired 10:09, stopped 4m, re-fired 13:24). A 5-minute break or longer
// qualifies as a genuine new run; shorter stops keep the batch held.
const FATIGUE_MIN_BREAK_MS = 5 * 60 * 1000;
// Trail gaps longer than this are NOT bridged when summing distance: a stale or
// failed poll leaves points minutes apart and the straight-line chord across a
// city would invent distance the path never took.
const TRAIL_MAX_LEG_MS = 120 * 1000;
// GPS jitter floor: parked receivers drift a few metres per fix; anything under
// 5 m between 15s samples is noise, never real movement (5 m / 15 s ≈ 1.2 km/h).
const TRAIL_MIN_LEG_KM = 0.005;

// Fatigue thresholds (minutes) -> alert_definitions.signal_code.
// Definition names are resolved at runtime via isAlertActiveForCC — nothing
// here is hardcoded by name. Sorted ascending so each threshold fires once.
const FATIGUE_THRESHOLDS = [
  { minutes: 180, signalCode: FATIGUE_3H_CODE }, // Driver Fatigue 3h
  { minutes: 360, signalCode: FATIGUE_6H_CODE }, // Driver Fatigue 6h
  { minutes: 480, signalCode: DURATION_8H_CODE }, // 8 Hour Duration Check
  { minutes: 540, signalCode: FATIGUE_9H_CODE }, // Driver fatigue 9h
  { minutes: 720, signalCode: DURATION_12H_CODE }, // 12 Hour Duration Check
  { minutes: 900, signalCode: DURATION_15H_CODE }, // 15 Hour Duration Check
];

// Thresholds the clock has ALREADY passed at first sighting → recorded as
// alerted, so a baseline never replays a batch the vehicle already served.
function baselineCrossedThresholds(curMinutes) {
  if (!Number.isFinite(curMinutes) || curMinutes <= 0) return [];
  return FATIGUE_THRESHOLDS.filter((t) => curMinutes >= t.minutes).map((t) => t.signalCode);
}

// Pure fire/re-arm decision for the fatigue + duration thresholds. Exported so
// the rule ("once per continuous run") can be tested without a poller or DB.
//   rearm — held codes whose threshold the clock has dropped back below
//           (a genuine new driving run started); remove them from memory.
//   fire  — not-yet-held thresholds the clock is past while driving; emit each.
//   Both sides require currDriving: a STOP must never clear the memory. Geotab
//   can resume with an inflated currentStateDuration (b101: 73s stop, resume
//   reported 04:24) — if the stop had re-armed, that inflated reading fired the
//   threshold again minutes after the operator resolved it.
//   curMinutes === null (unparseable/absent duration) → no change at all.
function planFatigueThresholds({ codes, curMinutes, currDriving }) {
  const held = new Set(Array.isArray(codes) ? codes : []);
  const rearm = [];
  const skipped = [];
  if (!Number.isFinite(curMinutes) || curMinutes < 0 || !currDriving) return { rearm, fire: [], skip: skipped };
  const crossed = [];
  for (const t of FATIGUE_THRESHOLDS) {
    if (held.has(t.signalCode)) {
      if (curMinutes < t.minutes) rearm.push(t.signalCode);
    } else if (curMinutes >= t.minutes) {
      crossed.push(t);
    }
  }
  // Catch-up policy: after a gap fire only the highest crossed threshold and
  // mark the lower ones held, so a reconnect cannot replay 3/6/8/9 together.
  const fire = crossed.length > 0 ? [crossed[crossed.length - 1]] : [];
  for (const t of crossed.slice(0, -1)) skipped.push(t.signalCode);
  return { rearm, fire, skip: skipped };
}

// ── Module state ──
let pollTimer = null;
let wsBroadcast = null;
let inFlight = false;
let lastTrailPruneAt = 0;

let cachedCredentials = null;
let credentialsExpiry = null;

let zonesState = { data: null, ts: 0 };
// Called by the Stops CRUD routes: drop the 5-min zones cache so stop alerts
// use the edited geometry on the next poll cycle, not up to 5 minutes later.
function invalidateZonesCache() { zonesState = { data: null, ts: 0 }; }
let fleetSet = null;
let fleetTs = 0;
let geotabMap = null;
let geotabMapTs = 0;

// ── Geotab HTTP helpers (self-contained for testability) ──

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

async function geotabAuthenticate() {
  if (cachedCredentials && credentialsExpiry && Date.now() < credentialsExpiry) {
    return cachedCredentials;
  }
  const database = process.env.GEOTAB_DATABASE;
  const userName = process.env.GEOTAB_USERNAME;
  const password = process.env.GEOTAB_PASSWORD;
  if (!database || !userName || !password) throw new Error('Geotab credentials not configured');

  const response = await geotabFetch({ method: 'Authenticate', params: { database, userName, password } });
  if (response.error) throw new Error(response.error.message || 'Geotab authentication failed');
  const result = response.result || {};
  cachedCredentials = {
    database: result.credentials?.database || database,
    sessionId: result.credentials?.sessionId,
    userName: result.credentials?.userName || userName,
  };
  credentialsExpiry = Date.now() + (4 * 60 * 60 * 1000);
  return cachedCredentials;
}

// ── Duration/Timespan parsing ──

// Parse a .NET TimeSpan ("HH:MM:SS", "d.hh:mm:ss", "-...", fractional seconds)
// or a plain millisecond number into milliseconds.
function parseGeotabDurationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  let s = value.trim();
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  let days = 0;
  const dot = s.indexOf('.');
  if (dot >= 0) {
    days = parseInt(s.slice(0, dot), 10) || 0;
    s = s.slice(dot + 1);
  }
  const parts = s.split(':').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts.slice(-3);
  const ms = ((days * 24 + h) * 3600 + m * 60 + sec) * 1000;
  return negative ? -ms : ms;
}

// ── Distance over the GPS trail (haversine) ────────────────────────────────
// Great-circle distance in km between two fixes. atan2 form — the numerically
// stable equivalent of the textbook 2·asin(√a).
function haversineKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every((v) => Number.isFinite(v))) return 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Distance actually covered inside [fromIso, toIso], summed from the GPS trail
// we already store every poll (telemetry_history, indexed device+time).
// `endpoint` is the CURRENT fix {lat, lon, t?}: the alert fires mid-loop, before
// this tick's trail row is written, so the final leg is appended explicitly.
// Returns kilometres, or null when the window holds no points (no data → the
// value simply isn't recorded, it is never faked as 0).
async function distanceOverTrail(deviceId, fromIso, toIso, endpoint = null) {
  if (!deviceId || !fromIso || !toIso) return null;
  try {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
    const res = await db.query(
      `SELECT lat, lon, EXTRACT(EPOCH FROM event_time) * 1000 AS t
         FROM telemetry_history
        WHERE device_id = $1
          AND event_time >= $2::timestamptz
          AND event_time <= $3::timestamptz
        ORDER BY event_time ASC`,
      [deviceId, from.toISOString(), to.toISOString()]
    );
    const points = (res.rows || [])
      .map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), t: Number(r.t) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t));
    if (points.length === 0) return null;
    if (endpoint && Number.isFinite(Number(endpoint.lat)) && Number.isFinite(Number(endpoint.lon))) {
      const t = endpoint.t != null ? Number(endpoint.t) : to.getTime();
      if (Number.isFinite(t)) {
        points.push({ lat: Number(endpoint.lat), lon: Number(endpoint.lon), t });
      }
    }
    let km = 0;
    let prev = null;
    for (const pt of points) {
      if (prev) {
        const dt = pt.t - prev.t;
        // Skip stale gaps (would invent a straight line across a city) and
        // sub-5m legs (GPS drift while parked).
        if (dt > 0 && dt <= TRAIL_MAX_LEG_MS) {
          const leg = haversineKm(prev.lat, prev.lon, pt.lat, pt.lon);
          if (leg >= TRAIL_MIN_LEG_KM) km += leg;
        }
      }
      prev = pt;
    }
    return Math.round(km * 1000) / 1000; // metres precision
  } catch (err) {
    console.error('[DEVSTATUS] trail distance failed:', err.message);
    return null;
  }
}

// ── Break qualification for fatigue re-arms ────────────────────────────────
// Gap between the CURRENT driving session and the one before it. Computed once
// per session start (primed in the transition branch) and cached per device.
// No prior session at all → treated as a qualifying break (first trip).
const sessionBreakCache = new Map(); // deviceId -> { startIso, qualified }

function isoOf(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function sessionBreakQualified(deviceId, sessionStartIso) {
  if (!deviceId || !sessionStartIso) return false; // can't prove a break → hold the batch
  const cached = sessionBreakCache.get(deviceId);
  if (cached && cached.startIso === sessionStartIso) return cached.qualified;
  let qualified;
  try {
    // Prefer the observed rest record. It is the explicit audit trail of what
    // we treated as rest (fresh isDriving=false -> next fresh isDriving=true).
    const observed = await db.getLatestClosedRestPeriod(deviceId, sessionStartIso).catch(() => null);
    if (observed && observed.classification) {
      qualified = observed.qualifies_for_fatigue_rearm === true;
      if (!qualified) {
        console.log(
          `[FATIGUE] ${deviceId}: observed rest ${observed.duration_seconds || 0}s < ${FATIGUE_MIN_BREAK_MS / 1000}s — held thresholds not re-armed`
        );
      }
    } else {
      // Legacy fallback for rows written before rest-period logging existed.
      const res = await db.query(
        `SELECT MAX(driving_ended_at) AS e
           FROM driving_sessions
          WHERE device_id = $1
            AND driving_ended_at IS NOT NULL
            AND driving_ended_at <= $2::timestamptz`,
        [deviceId, sessionStartIso]
      );
      const end = res.rows[0] && res.rows[0].e;
      if (!end) {
        qualified = false; // no observed rest and no prior session — do not guess
      } else {
        const gapMs = new Date(sessionStartIso).getTime() - new Date(end).getTime();
        qualified = gapMs >= FATIGUE_MIN_BREAK_MS;
        if (!qualified) {
          console.log(
            `[FATIGUE] ${deviceId}: break ${Math.round(gapMs / 1000)}s < ${FATIGUE_MIN_BREAK_MS / 1000}s — held thresholds not re-armed`
          );
        }
      }
    }
  } catch (err) {
    console.error('[DEVSTATUS] session-break lookup failed:', err.message);
    qualified = false; // lookup failed → never re-arm on guesswork
  }
  sessionBreakCache.set(deviceId, { startIso: sessionStartIso, qualified });
  return qualified;
}

// ── Cache loaders ──

async function getZones() {
  if (zonesState.data && Date.now() - zonesState.ts < ZONES_CACHE_TTL) return zonesState.data;
  const rows = await db.getHighRiskZones();
  const built = [];
  for (const z of rows) {
    let points = z.points;
    if (typeof points === 'string') {
      try { points = JSON.parse(points); } catch { continue; }
    }
    if (!Array.isArray(points) || points.length < 3) continue;
    const ring = points.map((p) => [Number(p.x), Number(p.y)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (ring.length < 3) continue;
    // Close ring if needed — turf.polygon requires closed ring (first == last)
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
      console.log(`[ZONE] auto-closed ring for zone ${z.name} (${z.id})`);
    }
    try {
      const poly = turf.cleanCoords(turf.polygon([ring]));
      built.push({ id: z.id, name: z.name, is_high_risk: !!z.is_high_risk, is_no_go: !!z.is_no_go, is_no_stopping: !!z.is_no_stopping, zone_category: z.zone_category || null, polygon: poly });
    } catch (err) {
      console.error(`[ZONE] invalid polygon for ${z.name} (${z.id}): ${err.message}`);
      continue;
    }
  }
  zonesState = { data: built, ts: Date.now() };
  return built;
}

async function getFleetSet() {
  if (fleetSet && Date.now() - fleetTs < META_CACHE_TTL) return fleetSet;
  const result = await db.query('SELECT fleet_number, registration_number FROM fleet_vehicles');
  const set = new Set();
  for (const row of result.rows) {
    if (row.fleet_number) set.add(String(row.fleet_number).trim().toUpperCase());
    if (row.registration_number) set.add(String(row.registration_number).trim().toUpperCase());
  }
  fleetSet = set;
  fleetTs = Date.now();
  return set;
}

async function getGeotabMap() {
  if (geotabMap && Date.now() - geotabMapTs < META_CACHE_TTL) return geotabMap;
  const result = await db.query(
    `SELECT gd.id, gd.name, gd.fleet_number, gd.license_plate, fv.mettax_device_id
     FROM geotab_devices gd
     LEFT JOIN fleet_vehicles fv ON fv.fleet_number = gd.fleet_number`
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.id, { 
      name: row.name, 
      fleetNumber: row.fleet_number, 
      licensePlate: row.license_plate,
      mettaxDeviceId: row.mettax_device_id
    });
  }
  geotabMap = map;
  geotabMapTs = Date.now();
  return map;
}

function isRegisteredToken(fleetNumber, licensePlate, fleetSet) {
  return !!(
    (fleetNumber && fleetSet.has(String(fleetNumber).trim().toUpperCase())) ||
    (licensePlate && fleetSet.has(String(licensePlate).trim().toUpperCase()))
  );
}

function findCurrentZone(zones, lat, lon) {
  for (const z of zones) {
    try {
      if (turf.booleanPointInPolygon(turf.point([lon, lat]), z.polygon)) {
        return { zone_id: z.id, zone_name: z.name, is_high_risk: z.is_high_risk, is_no_go: z.is_no_go };
      }
    } catch { /* skip bad polygon */ }
  }
  return null;
}

// ── Alert emission ──

// Create a device-status alert GROUP. Dedup rule (upsertAlertGroup):
// if the same vehicle already has an ACTIVE (unresolved) group for the same
// alarm_type, its counter is bumped — no duplicate insert. Otherwise a new
// group is created. Definition must be active for the vehicle's cost center
// (isAlertActiveForCC); a vehicle with no cost center still gets the alert as
// long as it exists in fleet_vehicles.
async function emitDeviceStatusAlert({ deviceId, fleetNumber, licensePlate, signalCode, alarmText, lat, lon, speed, ts, extra = {}, distanceKm = null, durationSeconds = null }) {
  try {
    // Vehicle override: this vehicle must not raise this alert (checked
    // before anything is written — no group, no event row, no alert).
    const overrides = require('./vehicleAlertOverrides');
    if (overrides.isSuppressedSync({ fleetNumber, registration: licensePlate, signalCode })) {
      logDropOnce(`ovr:${signalCode}:${fleetNumber || deviceId}`, `[DEVSTATUS] suppressed ${signalCode} for ${fleetNumber || deviceId}: vehicle alert override`);
      return null;
    }
    const identityMod = require('../vehicles/identity');
    let identity = null;
    try {
      identity = await identityMod.resolveVehicle({ deviceId, fleetNumber, registration: licensePlate });
    } catch (_) { identity = null; }
    const canonicalId = identity?.fleetNumber || fleetNumber || deviceId;
    const sourceId = deviceId;
    const ccId = identity?.costCenterId == null
      ? await findVehicleCostCenterId(canonicalId).catch(() => null)
      : identity.costCenterId;
    const authz = require('../alerts/authorization');
    const def = await authz.resolveDefinitionForVehicle({ costCenterId: ccId, signalCode }).catch(() => null);
    if (!def) {
      logDropOnce(`def:${signalCode}:${ccId}`, `[DEVSTATUS] dropped ${signalCode} for ${canonicalId}: no active definition for cost centre ${ccId}`);
      return null;
    }

    const deviceName = fleetNumber
      ? `${fleetNumber}${licensePlate ? ' - ' + licensePlate : ''}`
      : (licensePlate || deviceId);

    if (!(await isRegisteredVehicle({ deviceId: canonicalId, deviceName }))) {
      logDropOnce(`reg:${deviceId}`, `[DEVSTATUS] dropped alerts for ${deviceName}: not in fleet_vehicles (registry guard)`);
      return null;
    }

    const alertId = `dst-${canonicalId}-${signalCode}-${Date.now()}`;
    const alarmTs = ts || new Date().toISOString();

    if (isSelfMonitoringZoneAlert({ signalCode, alarmType: def.name })) {
      const kind = signalCode === ZONE_APPROACHING_CODE
        ? 'approaching'
        : signalCode === SIGNAL_LOSS_ENTRY_CODE
          ? 'signal_loss'
          : 'entering';
      const zoneId = extra.zoneId ?? extra.zone_id ?? null;
      const zoneName = extra.zoneName ?? extra.zone_name ?? null;
      if (kind === 'entering' && zoneId) {
        zoneNotifications.removeApproach(canonicalId, zoneId);
      }
      zoneNotifications.upsert({
        fleet_number: canonicalId,
        device_id: sourceId,
        plate: licensePlate || null,
        cost_center_id: ccId,
        kind,
        alert_type: def.name,
        zone_id: zoneId,
        zone_name: zoneName,
        severity: String(def.severity || 'MEDIUM').toLowerCase(),
        eta_seconds: extra.etaSeconds ?? null,
        distance_meters: extra.distanceMeters ?? null,
        lat: lat ?? null,
        lon: lon ?? null,
        speed: speed ?? null,
      });
      await db.query(
        `INSERT INTO telematics_events (device_id, vehicle_id, license_plate, fleet_number, plate,
          event_type, event_code, severity, latitude, longitude, speed, description, zone_name, raw_data, event_time, distance, duration_seconds,
          source_device_id, geotab_device_id, mettax_device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          canonicalId, canonicalId, licensePlate || null, fleetNumber || canonicalId, licensePlate || null,
          def.name, signalCode, String(def.severity || 'MEDIUM').toUpperCase(),
          lat ?? null, lon ?? null, speed ?? null,
          alarmText || def.name, zoneName,
          JSON.stringify({ signalCode, source: 'deviceStatus', notificationOnly: true, ...extra }),
          alarmTs,
          Number.isFinite(distanceKm) && distanceKm >= 0 ? distanceKm : null,
          Number.isFinite(durationSeconds) && durationSeconds >= 0 ? Math.round(durationSeconds) : null,
          sourceId || null, identity?.geotabDeviceId || sourceId || null, identity?.mettaxDeviceId || null,
        ]
      ).catch(() => {});
      return { notification_only: true, alarmType: def.name };
    }

    // Operator cooldown: while a timer runs for this vehicle + alert type the
    // occurrence goes to the backup mirrors and NOTHING reaches the board.
    // Returns a truthy object so fatigue/speed consume their memory exactly
    // once (no 15s retry storm) and no broadcast ever runs; zone flows ignore
    // the return value. After the window the next crossing creates normally.
    try {
      const cooldownMod = require('./alertCooldowns');
      let cooldown = await cooldownMod.getActiveCooldown(canonicalId, def.name);
      if (!cooldown && sourceId && sourceId !== canonicalId) {
        cooldown = await cooldownMod.getActiveCooldown(sourceId, def.name);
      }
      if (cooldown) {
        await cooldownMod.recordSuppressed(cooldown, {
          deviceId: canonicalId, deviceName, alarmType: def.name, alarmText: alarmText || def.name,
          alertId, alarmTs, lat, lon, speed,
          severity: String(def.severity || 'MEDIUM').toLowerCase(),
          fleetNumber: fleetNumber || null, sourceType: 'telematics',
        }, {
          id: alertId, deviceId: canonicalId, deviceName, alarmType: def.name,
          alarmText: alarmText || def.name, alarmTs, lat, lon, speed,
          severity: String(def.severity || 'MEDIUM').toLowerCase(),
          fleetNumber: fleetNumber || null, sourceType: 'telematics',
        });
        console.log(`[COOLDOWN] ${fleetNumber || deviceId}: "${def.name}" occurrence stored in backup (ends ${cooldown.cooldown_until}) — no board alert`);
        return { cooldown_suppressed: true, alarmType: def.name };
      }
    } catch (cdErr) {
      console.error('[COOLDOWN] poller gate failed:', cdErr.message);
    }

    // Speeding: the Geotab feed may already have recorded this spike (tel-*)
    // within 60s. Skip the poller copy so one spike is not counted twice.
    if (signalCode === SPEED_85_CODE || signalCode === SPEED_90_CODE) {
      const feedDup = await db.query(
        `SELECT 1 FROM alert_groups
         WHERE device_id = $1 AND alarm_type = $2 AND source_type = 'telematics'
           AND last_alert_id LIKE 'tel-%'
           AND ABS(EXTRACT(EPOCH FROM (last_alert_ts - $3::timestamptz))) <= 60
         LIMIT 1`,
        [canonicalId, def.name, alarmTs]
      ).catch(() => ({ rows: [] }));
      if (feedDup.rows.length > 0) return null;
    }

    // Combo gate: stage this detection for any enabled AND-combination group it
    // belongs to. Additive — the individual alert below is raised regardless;
    // a completed combo only adds its merged card on top.
    const alertCombos = require('./alertCombos');
    const comboResult = await alertCombos.handleDetection({
      alertId,
      deviceId: canonicalId,
      deviceName,
      alarmType: def.name,
      alarmText: alarmText || def.name,
      alarmTs,
      lat: lat ?? null,
      lon: lon ?? null,
      speed: speed ?? null,
      severity: String(def.severity || 'MEDIUM').toLowerCase(),
      fleetNumber: fleetNumber || null,
      sourceType: 'telematics',
      costCenterId: ccId,
      sourceDeviceId: sourceId,
      distanceKm: distanceKm ?? null,
      durationSeconds: durationSeconds ?? null,
    });

    // Additive combos: the individual card is raised unconditionally; a
    // completed combo only appends its merged card. Neither suppresses the other.
    const individual = await db.upsertAlertGroup({
      deviceId: canonicalId,
      sourceDeviceId: sourceId,
      geotabDeviceId: identity?.geotabDeviceId || sourceId,
      mettaxDeviceId: identity?.mettaxDeviceId || null,
      deviceName,
      alarmType: def.name,
      alarmText: alarmText || def.name,
      alertId,
      alarmTs,
      lat: lat ?? null,
      lon: lon ?? null,
      speed: speed ?? null,
      sourceType: 'telematics',
      severity: String(def.severity || 'MEDIUM').toLowerCase(),
      fleetNumber: fleetNumber || null,
      registration: licensePlate || null,
      distanceKm: distanceKm ?? null,
      durationSeconds: durationSeconds ?? null,
    });
    const groupRows = [
      ...(individual ? [individual] : []),
      ...(comboResult.groupRows || []),
    ];

    // Archive per-event source row for history (alert_groups is the store).
    // A combo-staged detection is archived here too (it happened, whether or
    // not the combo completed). The pre-existing behaviour for a suppressed/
    // unregistered vehicle is unchanged: nothing is archived when no group was
    // created and no combo claimed it.
    if (groupRows.length > 0 || comboResult.action !== 'pass') {
      await db.query(
        `INSERT INTO telematics_events (device_id, vehicle_id, license_plate, fleet_number, plate,
          event_type, event_code, severity, latitude, longitude, speed, description, zone_name, raw_data, event_time, distance, duration_seconds,
          source_device_id, geotab_device_id, mettax_device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          canonicalId, canonicalId, licensePlate || null, fleetNumber || null, licensePlate || null,
          def.name, signalCode, String(def.severity || 'MEDIUM').toUpperCase(),
          lat ?? null, lon ?? null, speed ?? null,
          alarmText || def.name, extra.zoneName || null,
          JSON.stringify({ signalCode, source: 'deviceStatus', ...extra }),
          alarmTs,
          Number.isFinite(distanceKm) && distanceKm >= 0 ? distanceKm : null,
          Number.isFinite(durationSeconds) && durationSeconds >= 0 ? Math.round(durationSeconds) : null,
          sourceId || null, identity?.geotabDeviceId || sourceId || null, identity?.mettaxDeviceId || null,
        ]
      ).catch(() => {});
    }

    // Nothing on the board: the vehicle is not registered or the alert is
    // suppressed/on cooldown. A combo still waiting on other members no longer
    // empties this list — the individual card above is already raised.
    if (groupRows.length === 0) return null;

    for (const groupRow of groupRows) {
      const isCombo = groupRow.combo_name != null;
      const broadcastType = isCombo ? String(groupRow.alarm_type || def.name) : def.name;
      const broadcastText = isCombo
        ? `${broadcastType} — ${def.name} combined`
        : (alarmText || def.name);
      const baseSeverity = isCombo
        ? String(groupRow.severity || def.severity || 'MEDIUM').toLowerCase()
        : String(def.severity || 'medium').toLowerCase();

      if (wsBroadcast) {
        try {
          const groupCount = Number(groupRow.count || 1) || 1;
          const escalatedSeverity = escalateSeverity(baseSeverity, groupCount);
          const groupId = String(groupRow.id);
          wsBroadcast('new-alert', {
            alert: {
              id: groupId,
              alert_id: groupId,
              last_alert_id: alertId,
              alarmId: alertId,
              alarm_id: alertId,
              device_id: canonicalId,
              deviceId: canonicalId,
              vehicleId: canonicalId,
              source_device_id: sourceId || null,
              device_name: deviceName,
              deviceName,
              alert_type: broadcastType,
              alarm_type: broadcastType,
              type: broadcastType,
              title: broadcastType,
              alarmText: broadcastText,
              timestamp: new Date(alarmTs).toISOString(),
              alarmTs: new Date(alarmTs).toISOString(),
              last_occurrence: new Date(alarmTs).toISOString(),
              source_type: 'telematics',
              severity: escalatedSeverity,
              priority: escalatedSeverity,
              base_severity: baseSeverity,
              escalated: escalatedSeverity !== baseSeverity,
              status: 'new',
              resolved: false,
              count: groupCount,
              combo: isCombo ? groupRow.combo_name : undefined,
              group_key: groupRow.group_key || `${deviceId}:${broadcastType}`.toLowerCase(),
              lat: lat ?? null,
              lon: lon ?? null,
            },
          });
        } catch (_) { /* never block alert emission on WS */ }
      }
      console.log(`[DEVSTATUS] alert created group=${groupRow.id} (${broadcastType}) for ${fleetNumber || deviceId}`);
    }
    return groupRows[0];
  } catch (error) {
    console.error('[DEVSTATUS] alert emit failed:', error.message);
    return null;
  }
}

// ── Zone processing (per device, per poll) ──

async function processZoneForDevice(deviceId, fleetNumber, licensePlate, lat, lon, speed, dateTime, zones, entryMap, stopMap, prevLat, prevLon) {
  const nowTs = dateTime || new Date().toISOString();
  const currentZoneIds = [];
  const insideZones = [];
  const crossedZones = [];
  const wasInside = entryMap.get(deviceId) || new Set();
  
  // Line-intersect entry detection: check if the vehicle's path (prev->current) 
  // crosses a zone boundary. This catches entries even when both points are outside.
  const hasPrevPos = prevLat != null && prevLon != null;
  const pathLine = hasPrevPos ? turf.lineString([[prevLon, prevLat], [lon, lat]]) : null;

  for (const z of zones) {
    let isInside = false;
    let crossedBoundary = false;
    try {
      // Point-in-polygon for current position
      isInside = turf.booleanPointInPolygon(turf.point([lon, lat]), z.polygon);
      // Line-intersect: if we have a previous position, check if path crossed boundary
      if (pathLine) {
        const intersects = turf.lineIntersect(pathLine, z.polygon);
        crossedBoundary = intersects.features.length > 0;
      }
    } catch { continue; }
    
    // Vehicle is inside if current point is inside, OR if path crossed boundary
    // (crossed boundary + not already inside = entry event)
    if (isInside) {
      currentZoneIds.push(z.id);
      insideZones.push(z);
    } else if (crossedBoundary && !wasInside.has(z.id)) {
      // Path crossed the boundary but the current fix is outside. Record the
      // entry, but do NOT treat the vehicle as "inside" for stop tracking —
      // that was creating false stop alerts for zones beside the road.
      crossedZones.push(z);
      console.log(`[ZONE] boundary crossing detected for ${fleetNumber || deviceId} -> ${z.name} (crossed, current outside)`);
    }
  }

  // ── Predictive Detection: bearing + 45s look-ahead ───────────────────
  // Check zones the vehicle is approaching (will enter within 45s at current speed/bearing)
  if (hasPrevPos) {
    const prevPoint = turf.point([prevLon, prevLat]);
    const currentPoint = turf.point([lon, lat]);
    
    // 1. Calculate bearing (-180 to 180, 0 = North)
    let bearing = 0;
    try {
      bearing = turf.bearing(prevPoint, currentPoint);
    } catch { bearing = 0; }
    
    // 2. Project forward (45 seconds at current speed, min 1 km/h)
    const speedKms = Math.max(Number(speed) || 0, 1) / 3600; // km/s
    const lookAheadSeconds = 45;
    const distanceKm = speedKms * lookAheadSeconds;
    
    // 3. Predicted point
    let predictedPoint = currentPoint;
    try {
      predictedPoint = turf.destination(currentPoint, distanceKm, bearing, { units: 'kilometers' });
    } catch { /* fallback to current point */ }
    
    // 4. Trajectory vector
    const trajectoryVector = turf.lineString([currentPoint.geometry.coordinates, predictedPoint.geometry.coordinates]);
    
    // 5. Check zones not currently inside and not already entered
    for (const z of zones) {
      if (insideZones.some(iz => iz.id === z.id)) continue; // Already inside
      if (wasInside.has(z.id)) continue; // Was inside, exit handled separately
      // Approaching alerts are high-risk-only: no-go / no-stopping zones never
      // emit here (their entries + stops still alert via the entry/stop paths).
      if (categoryOf(z) !== 'high_risk') continue;

      try {
        const intersections = turf.lineIntersect(trajectoryVector, z.polygon);
        // A real entry crosses the boundary twice (in and out) and penetrates
        // the polygon. A single/tangent intersection is a vehicle passing by
        // the side — exactly the false positive this rule must not raise.
        if (intersections.features.length >= 2) {
          const entryPoint = intersections.features[0];
          const exitPoint = intersections.features[1];
          const penetrationKm = turf.distance(entryPoint, exitPoint, { units: 'kilometers' });
          if (penetrationKm < 0.03) {
            continue; // graze / side crossing
          }
          const distanceToEntry = turf.distance(currentPoint, entryPoint, { units: 'kilometers' });
          const etaSeconds = Number(speed) > 0 ? (distanceToEntry / (Number(speed) / 3600)) : Infinity;
          if (!Number.isFinite(etaSeconds) || etaSeconds > lookAheadSeconds) continue;
          
          // Emit "Approaching Zone" alert
          await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, 
            signalCode: ZONE_APPROACHING_CODE,
            alarmText: `Approaching High Risk Zone: ${z.name} (ETA ~${Math.round(etaSeconds)}s)`,
            lat, lon, speed, ts: nowTs,
            extra: {
              zoneId: z.id,
              zoneName: z.name,
              zoneType: 'high_risk',
              etaSeconds: Math.round(etaSeconds),
              distanceMeters: Math.round(distanceToEntry * 1000),
              penetrationMeters: Math.round(penetrationKm * 1000),
              bearing: bearing.toFixed(1)
            },
          });
          
          console.log(`[ZONE-PREDICT] ${fleetNumber || deviceId} approaching ${z.name} (bearing: ${bearing.toFixed(1)}°, ETA ~${Math.round(etaSeconds)}s)`);
        }
      } catch (e) {
        // Ignore prediction errors per zone
      }
    }
  }

  // Exits FIRST and never gated by "inside anything": any open entry whose zone
  // no longer contains this fix is closed, including when the vehicle is outside
  // every watched zone. (The old early return skipped this, leaving entries open.)
  for (const zoneId of wasInside) {
    if (currentZoneIds.includes(zoneId)) continue;
    try {
      await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = $2
         WHERE device_id = $1 AND zone_id = $3 AND is_active = TRUE`,
        [deviceId, nowTs, zoneId]
      );
      zoneNotifications.removeEntry(fleetNumber || deviceId, zoneId);
      wasInside.delete(zoneId);
    } catch (err) {
      console.error(`[ZONE] exit close failed device=${deviceId} zone=${zoneId}: ${err.message}`);
    }
  }

  // New entries → recorded for every watched zone. An entry is only ever
  // blocked by an entry that is still open for the SAME zone, never by other
  // zones or by recent alerts.
  for (const z of [...insideZones, ...crossedZones]) {
    if (wasInside.has(z.id)) continue;
    const riskLevel = z.is_no_go ? 'CRITICAL' : z.is_high_risk ? 'HIGH' : 'MEDIUM';
    const entry = await db.insertZoneEntry({
      deviceId,
      fleetNumber,
      licensePlate,
      zoneId: z.id,
      zoneName: z.name,
      riskLevel,
      latitude: lat,
      longitude: lon,
      speed: speed ?? null,
      entryTime: nowTs,
    });
    if (entry && (z.is_high_risk || z.is_no_go || z.is_no_stopping)) {
      // Determine zone type with priority: no_go > no_stopping > high_risk
      const zoneType = z.is_no_go ? 'no_go' : z.is_no_stopping ? 'no_stopping' : 'high_risk';
      const zoneConfig = {
        no_go: { code: NOGO_ENTRY_CODE, text: 'No-Go Zone' },
        no_stopping: { code: NO_STOP_ENTRY_CODE, text: 'No Stopping Zone' },
        high_risk: { code: ZONE_ENTRY_CODE, text: 'High Risk Area' },
      }[zoneType];
      await emitDeviceStatusAlert({
        deviceId, fleetNumber, licensePlate, signalCode: zoneConfig.code,
        alarmText: `Entering ${zoneConfig.text} in zone ${z.name}`,
        lat, lon, speed, ts: nowTs,
        extra: { zoneId: z.id, zoneName: z.name, zoneType },
      });
    }
  }

  // Zone stops: immediate + >1min alerts, persistent tracking. Stop thresholds
  // are per zone type — high-risk/no-go zones flag at speed < 5, No-Stopping at < 10.
  // Zone category is an explicit flag (is_no_stopping), never a name match.
  for (const z of insideZones) {
    const zoneType = categoryOf(z);
    if (zoneType === 'normal') continue;
    const stopThreshold = zoneType === 'no_stopping' ? STOP_SPEED_NO_STOPPING : STOP_SPEED;
    const isStopped = Number(speed) < stopThreshold;
    const stopKey = `${deviceId}:${z.id}`;
    let stop = stopMap.get(stopKey);

    if (isStopped) {
      if (!stop) {
        stop = await db.startZoneStopEvent({
          deviceId, fleetNumber, licensePlate,
          zoneId: z.id, zoneName: z.name, zoneType, stoppedAt: nowTs,
        });
        if (stop) stopMap.set(stopKey, stop);
      }
      if (!stop) continue;

      // Immediate "Stopped High Risk area" on first stop poll — both zone types.
      // Mark the flag ONLY when the emit produced a group (or the operator's
      // cooldown deliberately diverted it). A dropped emit must retry.
      if (!stop.immediate_alert_sent) {
        const sent = await emitDeviceStatusAlert({
          deviceId, fleetNumber, licensePlate, signalCode: ZONE_STOP_IMMEDIATE_CODE,
          alarmText: `Stopped ${zoneType === 'no_stopping' ? 'No Stopping zone' : 'High Risk area'} in ${z.name}`,
          lat, lon, speed, ts: nowTs,
          extra: { zoneName: z.name },
        });
        if (sent) {
          await db.markZoneStopAlertSent(stop.id, 'immediate');
          stop.immediate_alert_sent = true;
        }
      }
    } else if (stop) {
      // Moving again while inside → close the stop event.
      await db.endZoneStopEvent(stop.id, nowTs);
      stopMap.delete(stopKey);
    }
  }

  // Close stop events for zones we are no longer in.
  for (const [stopKey, stop] of [...stopMap.entries()]) {
    if (stopKey.startsWith(`${deviceId}:`) && !currentZoneIds.includes(stop.zone_id)) {
      await db.endZoneStopEvent(stop.id, nowTs);
      stopMap.delete(stopKey);
    }
  }

}

// ── Main poll ──

// ── Heartbeat + watchdog ──
// Every poll logs start/end with the last stage reached. The watchdog clears a
// poll that runs past POLL_STUCK_MS so the next tick can run, and logs the stage
// it was stuck in. A poll generation id stops a stale poll from clearing the
// flag of a newer one.
let pollGen = 0;
let pollStartedAt = 0;
let pollStage = 'idle';
let lastPollEndedAt = 0;
let lastPollMs = 0;
let lastPollError = null;
let watchdogTimer = null;
const fatigueDropLogged = new Set();
// Logs a drop reason once per key so gates are visible without flooding the log.
const dropLogged = new Set();
function logDropOnce(key, message) {
  if (dropLogged.has(key)) return;
  dropLogged.add(key);
  console.log(message);
}
const POLL_STUCK_MS = 60000;
const WATCHDOG_EVERY_MS = 15000;
const CAMERA_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const cameraCheckCache = new Map(); // deviceId -> last check timestamp

// One line per driving-state flip, rate-limited per device, so prod shows which
// snapshots were driving the churn (trusted=false ⇒ stale/offline payload that
// is now ignored) without flooding the log at 15s cadence.
const DRIVE_STATE_LOG_TTL_MS = 5 * 60 * 1000;
const driveStateLoggedAt = new Map();
function logDriveStateTransition({ deviceId, fleetNumber, prevDriving, currDriving, isFresh, communicating, fixAgeMs, durMs }) {
  const now = Date.now();
  const last = driveStateLoggedAt.get(deviceId) || 0;
  if (now - last < DRIVE_STATE_LOG_TTL_MS) return;
  driveStateLoggedAt.set(deviceId, now);
  if (driveStateLoggedAt.size > 2000) driveStateLoggedAt.clear();
  console.log(
    `[DRIVE-STATE] ${fleetNumber || deviceId}: ${prevDriving}→${currDriving} ` +
    `trusted=${isFresh} communicating=${communicating} ` +
    `fixAgeMs=${Number.isFinite(fixAgeMs) ? Math.round(fixAgeMs) : 'na'} durMs=${durMs ?? 'na'}`
  );
}

function markStage(name) { pollStage = name; }

function getPollHealth() {
  return {
    inFlight,
    stage: pollStage,
    startedAt: pollStartedAt ? new Date(pollStartedAt).toISOString() : null,
    runningMs: inFlight ? Date.now() - pollStartedAt : 0,
    lastEndedAt: lastPollEndedAt ? new Date(lastPollEndedAt).toISOString() : null,
    lastMs: lastPollMs,
    lastError: lastPollError,
  };
}

function watchdogTick() {
  if (!inFlight) return;
  const running = Date.now() - pollStartedAt;
  if (running > POLL_STUCK_MS) {
    console.error(`[DEVSTATUS] WATCHDOG: poll#${pollGen} stuck for ${running}ms at stage=${pollStage}; clearing so next tick runs`);
    lastPollError = `stuck at ${pollStage} for ${running}ms`;
    inFlight = false;
    pollGen++; // the stuck poll's finally must not touch the flag
  }
}

// Stop timers are evaluated from persisted stop events every poll, not from
// the current fix. A vehicle that stops and goes stale still gets its >1min
// alert. created_at is server time, immune to device clock skew.
async function sweepStopTimers(stopMap) {
  if (!stopMap || stopMap.size === 0) return;
  for (const stop of stopMap.values()) {
    if (!stop || stop.minute_alert_sent) continue;
    const started = new Date(stop.created_at || stop.stop_start).getTime();
    if (!Number.isFinite(started)) continue;
    if (Date.now() - started < 60000) continue;
    const codes = stopSignalCodes(stop.zone_type);
    let pos = null;
    try {
      const r = await db.query(
        'SELECT latitude, longitude, speed FROM vehicle_status WHERE device_id = $1 OR fleet_number = $2 LIMIT 1',
        [stop.device_id, stop.fleet_number || stop.device_id]
      );
      pos = r.rows[0] || null;
    } catch (_) { pos = null; }
    const sent = await emitDeviceStatusAlert({
      deviceId: stop.device_id,
      fleetNumber: stop.fleet_number,
      licensePlate: stop.license_plate,
      signalCode: codes.minute,
      alarmText: `Stopped > 1min in ${codes.isNoStopping ? 'No Stopping zone' : 'High Risk area'} ${stop.zone_name}`,
      lat: pos?.latitude ?? null,
      lon: pos?.longitude ?? null,
      speed: pos?.speed ?? null,
      ts: new Date().toISOString(),
      extra: { zoneName: stop.zone_name },
    });
    if (sent) {
      await db.markZoneStopAlertSent(stop.id, 'minute');
      stop.minute_alert_sent = true;
    }
  }
}

async function pollDeviceStatus() {
  if (inFlight) return;
  inFlight = true;
  const gen = ++pollGen;
  pollStartedAt = Date.now();
  markStage('auth');
  try {
    const credentials = await geotabAuthenticate();
    markStage('fetch-status');
    const response = await geotabFetch({
      method: 'Get',
      params: { typeName: 'DeviceStatusInfo', credentials },
      id: 10,
      jsonrpc: '2.0',
    });
    if (response.error) {
      console.error('[DEVSTATUS] DeviceStatusInfo error:', response.error.message);
      return;
    }
    const statuses = response.result || [];
    if (statuses.length === 0) return;

    markStage('load-caches');
    const [fleetSet, gMap, zones] = await Promise.all([getFleetSet(), getGeotabMap(), getZones()]);

    // Open entries whose zone is no longer watched (flag removed or zone deleted)
    // can never be closed by a fix, so close them here once per poll.
    markStage('close-unwatched-entries');
    try {
      const watchedIds = zones.map((z) => z.id);
      const closed = await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = COALESCE(exit_time, NOW())
         WHERE is_active = TRUE AND NOT (zone_id = ANY($1::text[]))`,
        [watchedIds]
      );
      if (closed.rowCount > 0) console.log(`[ZONE] closed ${closed.rowCount} entries for unwatched zones`);
    } catch (err) {
      console.error('[ZONE] unwatched-entry close failed:', err.message);
    }

    // Batch-load active zone entries + active stop events (single queries).
    markStage('load-entries');
    const activeEntries = await db.query('SELECT device_id, zone_id FROM high_risk_zone_entries WHERE is_active = TRUE')
      .then((r) => r.rows).catch(() => []);
    const activeStops = await db.query('SELECT * FROM zone_stop_events WHERE stop_end IS NULL')
      .then((r) => r.rows).catch(() => []);
    const entryMap = new Map();
    for (const e of activeEntries) {
      if (!entryMap.has(e.device_id)) entryMap.set(e.device_id, new Set());
      entryMap.get(e.device_id).add(e.zone_id);
    }
    const stopMap = new Map();
    for (const s of activeStops) stopMap.set(`${s.device_id}:${s.zone_id}`, s);

    markStage('stop-timers');
    await sweepStopTimers(stopMap);

    // Batch-load current vehicle_status for all polled devices.
    const ids = statuses.map((d) => d.device?.id).filter(Boolean);
    const existingRows = await db.query('SELECT * FROM vehicle_status WHERE device_id = ANY($1::text[])', [ids])
      .then((r) => r.rows).catch(() => []);
    const vsMap = new Map(existingRows.map((r) => [r.device_id, r]));
    let telemetryPublished = 0;

    // ── Publish every polled speed before the DB/alert loop ──
    // The UI takes the latest sample it receives; there is no timestamp or
    // "changed since last poll" filter here. DB persistence/alert processing
    // still runs below, but it never delays the live card feed.
    for (const d of statuses) {
      const deviceId = d.device?.id;
      if (!deviceId) continue;
      const gDevice = gMap.get(deviceId);
      if (!gDevice) continue;
      const fleetNumber = gDevice.fleetNumber;
      const licensePlate = gDevice.licensePlate;
      let canonicalFleetNumber = fleetNumber
        ? normalizeFleetString(fleetNumber).toUpperCase() || null
        : null;
      if (!canonicalFleetNumber && licensePlate) {
        try {
          canonicalFleetNumber = await resolveFleetNumber({
            deviceId,
            vehicleRegistration: licensePlate,
          });
          canonicalFleetNumber = canonicalFleetNumber
            ? normalizeFleetString(canonicalFleetNumber).toUpperCase() || null
            : null;
        } catch { canonicalFleetNumber = null; }
      }
      if (!canonicalFleetNumber) continue;
      const speed = d.speed == null || d.speed === "" ? null : Number(d.speed);
      if (!Number.isFinite(speed)) continue;
      const dateTime = d.dateTime || new Date().toISOString();
      const lat = d.latitude ?? null;
      const lon = d.longitude ?? null;
      const currDriving = d.isDriving === true;
      const telemetryEvent = {
        device_id: deviceId,
        plate: gDevice.name || null,
        license_plate: licensePlate,
        fleet_number: canonicalFleetNumber,
        speed,
        lat,
        lon,
        bearing: d.bearing == null || d.bearing === '' ? null : (Number.isFinite(Number(d.bearing)) ? Number(d.bearing) : null),
        observed_at: dateTime,
        last_log_time: dateTime,
        current_zone: lat != null && lon != null ? findCurrentZone(zones, lat, lon) : null,
        is_driving: currDriving,
        // The card's Online state is based on isDriving, not on whether the
        // device is merely communicating with Geotab.
        is_online: currDriving,
        sequence: ++telemetrySequence,
        received_at: Date.now(),
      };
      if (lat != null && lon != null && wsBroadcast) {
        wsBroadcast('vehicle_position', { ...telemetryEvent, latitude: lat, longitude: lon });
      }
      sseHub.publishTelemetry(telemetryEvent);
      telemetryPublished++;
    }

    let positionUpdated = 0;
    let drivingChanged = 0;
    let freshCount = 0;
    let staleCount = 0;
    let offlineCount = 0;
    // Telemetry-history trail rows for this tick (device event time, not ours).
    const trailRows = [];

    markStage('device-loop');
    for (const d of statuses) {
      const deviceId = d.device?.id;
      if (!deviceId) continue;
      markStage(`device:${deviceId}`);
      const gDevice = gMap.get(deviceId);
      if (!gDevice) continue; // only known fleet devices

      const lat = d.latitude;
      const lon = d.longitude;
      const speed = d.speed;
      const dateTime = d.dateTime || new Date().toISOString();
      const fleetNumber = gDevice.fleetNumber;
      const licensePlate = gDevice.licensePlate;
      const restDeviceId = fleetNumber || deviceId;

      // Canonical fleet identity is the ONLY key the live telemetry stream may
      // use. Geotab sometimes reports "RH33 (RAPID)" while the fleet registry
      // says "RH33"; publishing the raw string meant the card never matched.
      // Geotab's raw "RH33 (RAPID)" must become registry "RH33". Normalizing
      // the reported fleet avoids a per-device DB lookup on every poll.
      let canonicalFleetNumber = fleetNumber
        ? normalizeFleetString(fleetNumber).toUpperCase() || null
        : null;
      if (!canonicalFleetNumber && licensePlate) {
        try {
          canonicalFleetNumber = await resolveFleetNumber({
            deviceId,
            vehicleRegistration: licensePlate,
          });
          canonicalFleetNumber = canonicalFleetNumber
            ? normalizeFleetString(canonicalFleetNumber).toUpperCase() || null
            : null;
        } catch { canonicalFleetNumber = null; }
      }
      if (!canonicalFleetNumber && !telemetryFleetMissLogged.has(deviceId)) {
        telemetryFleetMissLogged.add(deviceId);
        console.warn(`[DEVSTATUS] telemetry skipped: no canonical fleet for device ${deviceId} (${fleetNumber || "no fleet"})`);
      }

      // Freshness gate — dateTime is the device's own event time; isDeviceCommunicating
      // tells us it is currently talking to Geotab. Both are per-event, so no DB lookup.
      const fixAgeMs = dateTime ? Date.now() - new Date(dateTime).getTime() : Infinity;
      const communicating = d.isDeviceCommunicating === true;
      const isFresh = communicating && fixAgeMs <= DATA_FRESH_MS;
      const currDriving = d.isDriving === true;
      if (communicating) {
        if (isFresh) freshCount++;
        else staleCount++;
      } else {
        offlineCount++;
      }

      await db.upsertVehicleStatus(deviceId, {
        plate: gDevice.name || null,
        licensePlate,
        fleetNumber,
        speed: speed ?? null,
        latitude: lat ?? null,
        longitude: lon ?? null,
        bearing: d.bearing == null || d.bearing === '' ? null : (Number.isFinite(Number(d.bearing)) ? Number(d.bearing) : null),
        lastLogTime: dateTime,
      });
      positionUpdated++;

      // Real online state (isDeviceCommunicating + duration).
      try {
        let onlineSince = null;
        if (communicating) {
          const durMs = parseGeotabDurationMs(d.currentStateDuration);
          if (durMs !== null && durMs >= 0) onlineSince = new Date(Date.now() - durMs).toISOString();
        }
        await db.query('UPDATE vehicle_status SET is_online = $2, online_since = $3 WHERE device_id = $1', [deviceId, communicating, onlineSince]);
      } catch { /* online state must never block the poll */ }

      const prevRow = vsMap.get(deviceId);
      const firstSeen = !prevRow;
      const prevDriving = prevRow?.is_driving ?? null; // null initially / unknown
      const durMs = parseGeotabDurationMs(d.currentStateDuration);
      // Session whose break gates fatigue re-arms. Kept as a local so the tick
      // that STARTS a session uses its OWN start (prevRow still holds the old
      // one until the next reload) — the gap must be current-session vs prev.
      let currentSessionStartIso = isoOf(prevRow?.driving_since);

      // First sighting (fresh setup/rebuild or never-seen device): store the
      // observed state + its duration as a SILENT baseline. No alerts fire —
      // measurement continues forward from this point:
      //   - fatigue: thresholds already crossed at baseline are pre-seeded as
      //     "already alerted" so only NEW thresholds fire later,
      //   - speed: flag is set if the vehicle is already speeding so the first
      //     alert only comes after a drop-then-re-cross,
      //   - zones: stops/entries are tracked but their alerts are suppressed.
      // An open driving session IS started for vehicles already on the road.
      if (firstSeen) {
        const spd0 = Number(speed) || 0;
        const curMinutes = durMs !== null && durMs > 0 ? durMs / 60000 : 0;
        // Baseline: thresholds the clock has ALREADY crossed are recorded as
        // alerted, so a vehicle that appears mid-run (new registration, wiped
        // row, failed vehicle_status load) never replays the batch it already
        // served — only genuinely new crossings fire later.
        const preAlerted = baselineCrossedThresholds(curMinutes);
        // Speed baseline: the 2-minute 85 clock starts NOW when already
        // speeding — nothing fires on first sighting, and the alert lands only
        // if the run survives the full sustain window from here. 90 keeps its
        // baseline silence (drop-then-recross), per "no alerts on first sight".
        const ep85Baseline = Number.isFinite(spd0) && spd0 >= 86
          ? (isoOf(dateTime) || new Date().toISOString())
          : null;
        const ccId = await findVehicleCostCenterId(fleetNumber || deviceId).catch(() => null);
        if (currDriving) {
          const session = await db.startDrivingSession({
            deviceId, fleetNumber, registrationNumber: licensePlate,
            costCenterId: ccId, startedAt: dateTime,
          });
          if (isFresh) {
            await db.endRestPeriod({
              deviceId: restDeviceId, restEnd: dateTime, afterSessionId: session?.id || null,
              minBreakSeconds: FATIGUE_MIN_BREAK_MS / 1000, reason: 'first_seen_resume',
            }).catch(() => {});
          }
          currentSessionStartIso = dateTime;
          await sessionBreakQualified(deviceId, dateTime); // prime break cache
        } else if (isFresh) {
          await db.startRestPeriod({
            deviceId: restDeviceId, sourceDeviceId: deviceId, fleetNumber,
            registrationNumber: licensePlate, restStart: dateTime,
          }).catch(() => {});
        }
        await db.updateVehicleStatusDriving(deviceId, {
          isDriving: currDriving,
          drivingSince: currDriving ? dateTime : null,
          currentStateDurationMs: durMs,
          maxSpeed: spd0,
          speed85Alerted: false,
          speed90Alerted: spd0 >= 90,
          speed85EpisodeSince: ep85Baseline,
          fatigueAlertedThresholds: preAlerted,
          fatigueAlertedSessionStart: currDriving ? dateTime : null,
        });
        vsMap.set(deviceId, {
          ...(prevRow || {}), id: deviceId, is_driving: currDriving,
          speed_85_alerted: false, speed_90_alerted: spd0 >= 90,
          speed_85_episode_since: ep85Baseline,
          fatigue_alerted_thresholds: JSON.stringify(preAlerted),
          fatigue_alerted_session_start: currDriving ? dateTime : null,
        });
      } else {
      // Driving transition — only when a stored value FLIPS. Restart-safe:
      // a stored true stays true until a false arrives (and vice versa).
      if (currDriving !== prevDriving) {
        logDriveStateTransition({ deviceId, fleetNumber, prevDriving, currDriving, isFresh, communicating, fixAgeMs, durMs });
        // Only a LIVE snapshot (fresh fix + currently communicating) may flip
        // stored driving state. Stale/offline payloads carry isDriving=false as
        // a side effect of not talking to Geotab — honouring them churned
        // driving_sessions AND wiped the fatigue/speed alert memory while the
        // Geotab clock kept counting, which is what re-fired already-served
        // 3h/6h/9h thresholds minutes after they were resolved.
        if (isFresh) {
          if (currDriving) {
            const ccId = await findVehicleCostCenterId(fleetNumber || deviceId).catch(() => null);
            const session = await db.startDrivingSession({
              deviceId, fleetNumber, registrationNumber: licensePlate,
              costCenterId: ccId, startedAt: dateTime,
            });
            await db.endRestPeriod({
              deviceId: restDeviceId, restEnd: dateTime, afterSessionId: session?.id || null,
              minBreakSeconds: FATIGUE_MIN_BREAK_MS / 1000, reason: 'driving_resumed',
            }).catch(() => {});
            currentSessionStartIso = dateTime;
            await sessionBreakQualified(deviceId, dateTime); // prime break cache
            // Deliberately does NOT touch fatigue_alerted_thresholds or the
            // speed episode flags: fatigue re-arms only when BOTH the Geotab
            // clock drops below an alerted threshold AND the gap before THIS
            // session was a real break (>= FATIGUE_MIN_BREAK_MS); speed only
            // after its below-threshold dwell. A transition alone must never
            // make an alert that already fired fire again.
            await db.updateVehicleStatusDriving(deviceId, {
              isDriving: true,
              drivingSince: dateTime,
              currentStateDurationMs: durMs,
              maxSpeed: speed ?? 0,
            });
          } else {
            const ended = await db.endDrivingSession(deviceId, dateTime);
            await db.startRestPeriod({
              deviceId: restDeviceId, sourceDeviceId: deviceId, fleetNumber,
              registrationNumber: licensePlate, restStart: dateTime,
              beforeSessionId: ended?.id || null,
            }).catch(() => {});
            await db.updateVehicleStatusDriving(deviceId, {
              isDriving: false,
              drivingSince: null,
              currentStateDurationMs: durMs,
            });
          }
          drivingChanged++;
          vsMap.set(deviceId, { ...prevRow, is_driving: currDriving });
        }
      } else {
        // Same state: keep duration + max speed fresh, never touch driving flags.
        // Stale snapshots must not roll the stored duration backwards either —
        // only a live reading advances it.
        if (isFresh) {
          if (!currDriving) {
            await db.startRestPeriod({
              deviceId: restDeviceId, sourceDeviceId: deviceId, fleetNumber,
              registrationNumber: licensePlate, restStart: dateTime,
            }).catch(() => {});
          }
          await db.updateVehicleStatusDriving(deviceId, {
            currentStateDurationMs: durMs,
            maxSpeed: Math.max(Number(prevRow.max_speed_this_session) || 0, Number(speed) || 0),
          });
        }
      }
      }

      // ── Alert checks: registered vehicles only, need coords ──
      if (firstSeen) {
        // First sighting still contributes the starting fix to the trail, so a
        // later 2-minute speed window measures from the actual first sample.
        if (lat != null && lon != null) trailRows.push([deviceId, fleetNumber || null, licensePlate || null, lat, lon, dateTime]);
        continue; // baseline only — no alerts on first sighting
      }
      if (!isRegisteredToken(fleetNumber, licensePlate, fleetSet)) continue;
      if (lat == null || lon == null) continue;

      // Fatigue/duration from the authoritative Geotab clock (currentStateDuration)
      // — the thing that both fires and re-arms a threshold:
      //   fire:   clock is past a threshold that is not yet alerted, while driving;
      //   re-arm: while DRIVING the clock dropped BELOW an alerted threshold AND
      //           the gap before the CURRENT session was a REAL break
      //           (>= FATIGUE_MIN_BREAK_MS). Stops, stale readings and short
      //           robot/fuel stops never clear memory — Geotab restarts its
      //           clock on any state change, so without the break gate a
      //           4-minute stop re-fires the 3h batch inside the same shift
      //           (EX65: fired 10:09, stopped 4m, re-fired 13:24).
      // A threshold therefore never fires twice while the clock still reads past
      // it, no matter how often the driving flag flaps. Only fresh readings may
      // change the memory (stale/offline payloads are observational only).
      const alertedFatigue = (() => {
        try { return JSON.parse(prevRow.fatigue_alerted_thresholds || '[]'); } catch { return []; }
      })();
      let newFatigue = [...alertedFatigue];
      let fatigueSessionStart = isoOf(prevRow.fatigue_alerted_session_start);
      if (isFresh) {
        const curMinutes = durMs !== null && durMs > 0 ? durMs / 60000 : null;
        const plan = planFatigueThresholds({ codes: newFatigue, curMinutes, currDriving });
        if (plan.rearm.length > 0) {
          // Re-arm is only legal in a DIFFERENT session. A Geotab clock reset
          // inside the same session must never replay an already-served batch.
          const sessionChanged = !!(
            fatigueSessionStart && currentSessionStartIso && currentSessionStartIso !== fatigueSessionStart
          );
          const breakOk = sessionChanged && await sessionBreakQualified(deviceId, currentSessionStartIso);
          if (!breakOk) plan.rearm = [];
        }
        for (const code of plan.rearm) {
          newFatigue = newFatigue.filter((c) => c !== code);
        }
        // A gap can cross several thresholds at once. Those lower thresholds are
        // recorded as held without firing, so only the highest one alerts.
        for (const code of plan.skip || []) {
          if (!newFatigue.includes(code)) newFatigue.push(code);
        }
        // Km driven in the CURRENT driving session — one trail query per fire,
        // never per poll. Stored on the archive row so the alert modal can show
        // how far the driver went on this run.
        let sessionKm = null;
        if (plan.fire.length > 0) {
          sessionKm = await distanceOverTrail(deviceId, currentSessionStartIso || prevRow.driving_since, dateTime, { lat, lon });
        }
        for (const t of plan.fire) {
          const groupRow = await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, signalCode: t.signalCode,
            alarmText: `${defNameFor(t.signalCode)} exceeded (${t.minutes} min)`,
            lat, lon, speed, ts: dateTime,
            extra: { drivingMinutes: Math.round(curMinutes) },
            distanceKm: sessionKm,
            durationSeconds: Math.round(curMinutes * 60),
          });
          // Record the threshold ONLY once its alert exists. A failed emit (gate,
          // missing definition, DB error) writes nothing, so it is retried on the
          // next poll instead of being silently consumed.
          if (groupRow) {
            newFatigue.push(t.signalCode);
            fatigueSessionStart = currentSessionStartIso || isoOf(prevRow.driving_since);
          } else {
            const key = `${deviceId}:${t.signalCode}`;
            if (!fatigueDropLogged.has(key)) {
              fatigueDropLogged.add(key);
              console.log(`[FATIGUE] no alert created for ${fleetNumber || deviceId} ${t.minutes}h threshold (will retry); see the reason logged above`);
            }
          }
        }
      }

      // Speed alerts — one alert per sustained episode.
      //   90 km/h: flags on the FIRST fresh sample at/above 90 (unchanged).
      //   85 km/h: flags only after >= SPEED_85_SUSTAIN_MS (2 min) spent
      //            continuously at/above 86 (Geotab reports 85 km/h as 86).
      // Re-arm: either threshold fires again only after speed stays below it
      // for SPEED_REARM_DWELL_MS, so brief dips don't re-trigger. Only fresh
      // readings may advance the episode/re-arm state (stale dips can't).
      const spd = Number(speed);
      let s85 = !!prevRow.speed_85_alerted;
      let s90 = !!prevRow.speed_90_alerted;
      // Current continuous >=86 run: started when the first fresh sample at/above
      // 86 landed, cleared by the first fresh sample below 86 (strict — any dip
      // restarts the 2-minute count). Stale or speedless samples never touch it.
      let ep85 = prevRow.speed_85_episode_since
        ? new Date(prevRow.speed_85_episode_since).getTime()
        : null;
      if (!Number.isFinite(ep85)) ep85 = null;
      // Speeding diagnostics: log every snapshot at or above 80 km/h so a missed
      // alert can be explained from the data (fresh flag + prior alert state).
      if (spd >= 80) {
        console.log(
          `[SPEED-POLL] ${fleetNumber || deviceId} ${licensePlate || ''} spd=${spd} fresh=${isFresh} at=${dateTime} ` +
          `prev85=${s85} prev90=${s90} ep85AgeS=${ep85 === null ? 'none' : Math.max(0, Math.round((Date.now() - ep85) / 1000))}`
        );
      }
      let dwell85 = prevRow.speed_85_dwell_since ? new Date(prevRow.speed_85_dwell_since).getTime() : null;
      let dwell90 = prevRow.speed_90_dwell_since ? new Date(prevRow.speed_90_dwell_since).getTime() : null;

      if (isFresh) {
        const sampleMsRaw = new Date(dateTime).getTime();
        const nowMs = Number.isFinite(sampleMsRaw) ? sampleMsRaw : Date.now();

        // 85 episode clock (strict): a fresh finite sample >=86 starts/continues
        // the run; a fresh sample <86 ends it. Non-finite (no speed) samples are
        // unknowns — they neither advance nor reset the clock.
        if (Number.isFinite(spd)) {
          if (spd >= 86) {
            if (ep85 === null) ep85 = nowMs;
          } else {
            ep85 = null;
          }
        }

        // Re-arm bookkeeping: while alerted, count a continuous below-threshold
        // dwell; a re-crossing resets it (same episode).
        if (spd < 90) {
          if (s90) {
            if (dwell90 === null) dwell90 = nowMs;
            else if (nowMs - dwell90 >= SPEED_REARM_DWELL_MS) { s90 = false; dwell90 = null; }
          }
        } else {
          dwell90 = null;
        }
        if (spd < 86) {
          if (s85) {
            if (dwell85 === null) dwell85 = nowMs;
            else if (nowMs - dwell85 >= SPEED_REARM_DWELL_MS) { s85 = false; dwell85 = null; }
          }
        } else {
          dwell85 = null;
        }

        // Distance covered in the CURRENT 85+ run (haversine over the GPS trail).
        // When the run started this very sample there is no window yet, so fall
        // back to the previous fix — that leg is the last ~15s at speed.
        const overspeedRunKm = async () => {
          const from =
            ep85 !== null && ep85 < nowMs
              ? new Date(ep85).toISOString()
              : prevRow.last_update
                ? new Date(prevRow.last_update).toISOString()
                : null;
          return distanceOverTrail(deviceId, from, dateTime, { lat, lon, t: nowMs });
        };

        // Only consume the threshold AFTER a successful emit (mirrors fatigue logic).
        // If emit returns null (no definition, DB error, feed dedupe), we retry next poll.
        if (spd >= 90 && !s90) {
          const groupRow = await emitDeviceStatusAlert({
            deviceId, fleetNumber, licensePlate, signalCode: SPEED_90_CODE,
            alarmText: `Speed ${spd} km/h exceeded 90 km/h`,
            lat, lon, speed, ts: dateTime,
            extra: { speed: spd, speedThreshold: 90 },
            distanceKm: 0,
            durationSeconds: 0,
          });
          if (groupRow) {
            s90 = true;
            s85 = true; // 90 supersedes 85
            dwell90 = null;
            dwell85 = null;
          } else {
            logDropOnce(`speed90:${deviceId}`, `[SPEED] 90 km/h alert dropped for ${fleetNumber || deviceId} (will retry); reason logged above`);
          }
        } else if (spd >= 86 && !s85) {
          // 2-minute gate: waiting for the run to mature is NOT a drop — the
          // threshold stays unconsumed and the emit happens on a later poll.
          if (ep85 !== null && nowMs - ep85 >= SPEED_85_SUSTAIN_MS) {
            const groupRow = await emitDeviceStatusAlert({
              deviceId, fleetNumber, licensePlate, signalCode: SPEED_85_CODE,
              alarmText: `Speed ${spd} km/h exceeded 85 km/h`,
              lat, lon, speed, ts: dateTime,
              extra: { speed: spd, speedThreshold: 86, episodeStartedAt: new Date(ep85).toISOString() },
              distanceKm: await overspeedRunKm(),
              durationSeconds: Math.max(SPEED_85_SUSTAIN_MS / 1000, (nowMs - ep85) / 1000),
            });
            if (groupRow) {
              s85 = true;
              dwell85 = null;
            } else {
              logDropOnce(`speed85:${deviceId}`, `[SPEED] 85 km/h alert dropped for ${fleetNumber || deviceId} (will retry); reason logged above`);
            }
          }
        }
      }

      const dwell85Ms = prevRow.speed_85_dwell_since ? new Date(prevRow.speed_85_dwell_since).getTime() : null;
      const dwell90Ms = prevRow.speed_90_dwell_since ? new Date(prevRow.speed_90_dwell_since).getTime() : null;
      const ep85Ms = prevRow.speed_85_episode_since ? new Date(prevRow.speed_85_episode_since).getTime() : null;
      if (s85 !== !!prevRow.speed_85_alerted || s90 !== !!prevRow.speed_90_alerted ||
          dwell85 !== dwell85Ms || dwell90 !== dwell90Ms || ep85 !== ep85Ms ||
          newFatigue.join(',') !== alertedFatigue.join(',')) {
        await db.updateVehicleStatusDriving(deviceId, {
          speed85Alerted: s85,
          speed90Alerted: s90,
          speed85DwellSince: dwell85 !== null ? new Date(dwell85).toISOString() : null,
          speed90DwellSince: dwell90 !== null ? new Date(dwell90).toISOString() : null,
          speed85EpisodeSince: ep85 !== null ? new Date(ep85).toISOString() : null,
          fatigueAlertedThresholds: newFatigue,
          fatigueAlertedSessionStart: fatigueSessionStart,
        });
      }

      // Zone entry / stop monitoring — only while the fix is current, so stale
      // last-known positions can't create or extend zone events.
      if (isFresh) {
        const prevLat = prevRow?.latitude;
        const prevLon = prevRow?.longitude;
        await processZoneForDevice(deviceId, fleetNumber, licensePlate, lat, lon, speed, dateTime, zones, entryMap, stopMap, prevLat, prevLon);
      }

      // Camera offline check — only when vehicle is driving and data is fresh
      if (currDriving && isFresh) {
        const mettaxDeviceId = prevRow?.mettax_device_id || gDevice.mettaxDeviceId;
        if (mettaxDeviceId) {
          await checkCameraStatus(deviceId, fleetNumber, licensePlate, mettaxDeviceId);
        }
      }

      // Trail: every coordinate, keyed by the device's own event time.
      if (lat != null && lon != null) {
        trailRows.push([deviceId, fleetNumber || null, licensePlate || null, lat, lon, dateTime]);
      }
    }

    // Bulk trail write (one statement) + hourly rolling 12h prune.
    if (trailRows.length > 0) {
      try {
        const vals = [];
        const params = [];
        trailRows.forEach((r, i) => {
          const b = i * 6;
          params.push(...r);
          vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::timestamptz)`);
        });
        await db.query(
          `INSERT INTO telemetry_history (device_id, fleet_number, registration, lat, lon, event_time)
           VALUES ${vals.join(',')}
           ON CONFLICT (device_id, event_time) DO NOTHING`
          , params);
      } catch (err) {
        console.error('[TRAIL] write failed:', err.message);
      }
    }
    if (!lastTrailPruneAt || Date.now() - lastTrailPruneAt > 3600000) {
      lastTrailPruneAt = Date.now();
      try {
        const pruned = await db.query(
          `DELETE FROM telemetry_history WHERE event_time < NOW() - INTERVAL '12 hours'`);
        console.log(`[TRAIL] pruned ${pruned.rowCount || 0} rows older than 12h`);
      } catch (err) {
        console.error('[TRAIL] prune failed:', err.message);
      }
    }

    console.log(`[DEVSTATUS] poll: ${statuses.length} statuses, ${positionUpdated} positions, ${drivingChanged} driving transitions | fresh ${freshCount}, stale ${staleCount}, offline ${offlineCount} | telemetry ${telemetryPublished}`);
    lastPollError = null;
  } catch (error) {
    lastPollError = `${pollStage}: ${error.message}`;
    console.error(`[DEVSTATUS] poll failed at stage=${pollStage}:`, error.message);
  } finally {
    if (gen === pollGen) {
      inFlight = false;
      lastPollEndedAt = Date.now();
      lastPollMs = lastPollEndedAt - pollStartedAt;
      console.log(`[DEVSTATUS] poll#${gen} end stage=${pollStage} ms=${lastPollMs}`);
    }
  }
}

function defNameFor(signalCode) {
  // Best-effort label for alert text; the authoritative name comes from the def.
  const m = FATIGUE_THRESHOLDS.find((t) => t.signalCode === signalCode);
  if (!m) return 'Driving duration';
  const labels = {
    'a43F6lFwgIUq_gkgmgSX08g': 'Driver Fatigue 3h',
    'aScBH27NHXUqTLcl8QcCo4g': 'Driver Fatigue 6h',
    'aXmPcWqFx3kKp1XKdQDQEYQ': '8 Hour Duration Check',
    'adT7lgnAOhEep8a1M4u09eg': 'Driver fatigue 9h',
    'aJ2f9avKM80Ch7JgyCqOl7A': '12 Hour Duration Check',
    'aTZcSSADJ60eeqxk2DNGkZA': '15 Hour Duration Check',
  };
  return labels[signalCode] || 'Driving duration';
}

// ── Control ──

function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

function startPoller(intervalMs = POLL_INTERVAL_MS) {
  if (pollTimer) clearInterval(pollTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  pollTimer = setInterval(() => {
    pollDeviceStatus().catch((err) => console.error('[DEVSTATUS] tick error:', err.message));
  }, intervalMs);
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_EVERY_MS);
  pollDeviceStatus().catch((err) => console.error('[DEVSTATUS] tick error:', err.message));
  console.log(`[DEVSTATUS] poller started (every ${intervalMs / 1000}s, watchdog ${POLL_STUCK_MS / 1000}s)`);
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function runOnce() {
  await pollDeviceStatus();
}

// Camera status check — calls Mettax gallery API to see if vehicle has recent screenshots
async function checkCameraStatus(deviceId, fleetNumber, licensePlate, mettaxDeviceId) {
  if (!mettaxDeviceId) return;
  const now = Date.now();
  const lastCheck = cameraCheckCache.get(deviceId) || 0;
  if (now - lastCheck < CAMERA_CHECK_INTERVAL_MS) return;
  cameraCheckCache.set(deviceId, now);

  try {
    const endTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const startTime = new Date(now - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    // Use the same apiClient that handles auth/token properly
    const apiClient = require('../helpers/apiClient');
    const response = await apiClient.makeRequest('/gallery/page/file/v2', {
      deviceIds: mettaxDeviceId,
      startTime,
      endTime,
      queryType: 'Device',
      pageSize: 10,
      pageIndex: 1,
    });
    const data = response?.data || {};
    const records = data?.records || [];
    const status = records.length > 0 ? 'online' : 'offline';
    const lastScreenshot = records.length > 0
      ? new Date(Math.max(...records.map(r => new Date(r.createTime).getTime()))).toISOString()
      : null;

    console.log(`[CAMERA] ${fleetNumber} (${mettaxDeviceId}): ${status}, ${records.length} screenshots in last 10min`);

    const previous = await db.query(
      'SELECT status FROM camera_status WHERE fleet_number = $1 LIMIT 1',
      [fleetNumber]
    ).catch(() => ({ rows: [] }));
    const previousStatus = previous.rows[0]?.status || null;

    await db.query(
      `INSERT INTO camera_status (fleet_number, reg, time_logged, status, countdown, last_screenshot, mettax_device_id)
       VALUES ($1, $2, NOW(), $3, INTERVAL '0', $4, $5)
       ON CONFLICT (fleet_number) DO UPDATE SET
         reg = EXCLUDED.reg,
         time_logged = NOW(),
         status = EXCLUDED.status,
         countdown = NOW() - camera_status.time_logged,
         last_screenshot = EXCLUDED.last_screenshot,
         mettax_device_id = EXCLUDED.mettax_device_id,
         updated_at = NOW()`,
      [fleetNumber, licensePlate || null, status, lastScreenshot, mettaxDeviceId]
    ).catch(err => console.error(`[CAMERA] status update failed for ${fleetNumber}:`, err.message));

    if (fleetNumber && previousStatus !== status) {
      sseHub.publishCamera({
        fleet_number: fleetNumber,
        status,
        last_screenshot: lastScreenshot,
        at: Date.now(),
      });
    }
  } catch (err) {
    console.error(`[CAMERA] check failed for ${fleetNumber}:`, err.message);
  }
}

module.exports = { startPoller, stopPoller, runOnce, setWsBroadcast, pollDeviceStatus, parseGeotabDurationMs, invalidateZonesCache, getPollHealth, emitDeviceStatusAlert, planFatigueThresholds, baselineCrossedThresholds, distanceOverTrail, haversineKm, sessionBreakQualified, FATIGUE_THRESHOLDS, SPEED_85_SUSTAIN_MS, SPEED_REARM_DWELL_MS, FATIGUE_MIN_BREAK_MS };