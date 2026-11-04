'use strict';
// Local-only E2E for the 85 sustain rule, 90 instant rule, and trail distance.
// Geotab is faked in-process (same harness as test-fatigue-poller.js); the
// vehicle MOVES 0.0032° lat per tick (~356 m ≈ 86 km/h at 15s cadence) so the
// haversine distance has real legs to sum.
//
// Run:  docker compose cp test-speed-sustain.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-speed-sustain.js

const https = require('https');
const realRequest = https.request.bind(https);

let nextStatus = null;
https.request = function (a, b, c) {
  const isUrlForm = typeof a === 'string' || a instanceof URL;
  const url = isUrlForm ? String(a) : '';
  const cb = typeof (isUrlForm ? c : b) === 'function' ? (isUrlForm ? c : b) : null;
  const options = isUrlForm ? (b || {}) : (a || {});
  const host = url || options.host || options.hostname || '';
  if (!String(host).includes('my.geotab.com')) {
    return isUrlForm ? realRequest(a, b, c) : realRequest(a, b);
  }
  const chunks = [];
  const req = {
    on: () => req,
    write: (ch) => chunks.push(Buffer.from(ch)),
    destroy: () => {},
    end: () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      let payload;
      if (body.method === 'Authenticate') {
        payload = { result: { credentials: { sessionId: 'test', database: 'test', userName: 'test', path: 'https://my.geotab.com' } } };
      } else {
        payload = { result: nextStatus ? [nextStatus] : [] };
      }
      const text = JSON.stringify(payload);
      const res = {
        statusCode: 200,
        headers: {},
        on(ev, fn) { if (ev === 'data') fn(text); else if (ev === 'end') fn(); return res; },
      };
      if (cb) cb(res);
    },
  };
  return req;
};

const { query } = require('./src/db/pool');
const poller = require('./src/services/deviceStatusPoller');

const DEVICE_ID = 'TESTSPD01';
const FLEET = 'VT06';
const REG = 'JGV566FS';
const SPEED85 = 'aURw7fNBdxEGWY3NXil_yIg';
const SPEED90 = 'aLv1Bv53LBkClq5rSQ5QPkQ';
const FATIGUE3H = 'a43F6lFwgIUq_gkgmgSX08g';
const S85_NAME = 'Heavy Duty Max Speeding 85km/h';          // local alert_definitions names
const S90_NAME = 'Heavy Duty Max Speeding 90KM/H';
const F3_NAME = 'Driver Fatigue 3h (Low)';

const BASE_LAT = 48.8566;
const BASE_LON = 2.3522;
const T0 = Date.now() - 60_000;              // synthetic timeline, always fresh
let tickIdx = 0;

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

function snap({ spd, dur = '00:00:10', driving = true }) {
  const lat = BASE_LAT + tickIdx * 0.0032;    // north-bound, ~356 m per leg
  return {
    device: { id: DEVICE_ID },
    latitude: lat,
    longitude: BASE_LON,
    speed: spd,
    dateTime: new Date(T0 + tickIdx * 15_000).toISOString(),
    isDeviceCommunicating: true,
    isDriving: driving,
    currentStateDuration: dur,
  };
}

async function tick(label, status) {
  nextStatus = status;
  await poller.pollDeviceStatus();
  tickIdx += 1;
  console.log(`  · ${label}`);
}

async function setNextEpisodeAge(secondsAgo) {
  const sampleIso = new Date(T0 + tickIdx * 15_000).toISOString();
  await query(
    "UPDATE vehicle_status SET speed_85_episode_since = $2::timestamptz - ($3 || ' seconds')::interval WHERE device_id = $1",
    [DEVICE_ID, sampleIso, secondsAgo]
  );
}

const vs = async () => (await query('SELECT * FROM vehicle_status WHERE device_id = $1', [DEVICE_ID])).rows[0] || null;
const groupsByType = async () => {
  const r = await query(
    'SELECT alarm_type, count(*)::int n, max(count)::int cnt FROM alert_groups WHERE (device_id = $1 OR source_device_id = $1) GROUP BY 1',
    [DEVICE_ID]
  );
  return Object.fromEntries(r.rows.map((x) => [x.alarm_type, { n: x.n, cnt: x.cnt }]));
};
const lastEvent = async (code) => {
  const r = await query(
    'SELECT distance, duration_seconds FROM telematics_events WHERE (device_id = $1 OR source_device_id = $1) AND event_code = $2 ORDER BY event_time DESC LIMIT 1',
    [DEVICE_ID, code]
  );
  return r.rows[0] || null;
};
const lastEventDistance = async (code) => (await lastEvent(code))?.distance ?? null;
const latestGroup = async (type) => {
  const r = await query(
    'SELECT speed, distance_km, duration_seconds FROM alert_groups WHERE (device_id = $1 OR source_device_id = $1) AND alarm_type = $2 ORDER BY last_alert_ts DESC LIMIT 1',
    [DEVICE_ID, type]
  );
  return r.rows[0] || null;
};

(async () => {
  console.log('== prep ==');
  await query('DELETE FROM alerts WHERE (device_id = $1 OR source_device_id = $1)', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM alert_groups WHERE (device_id = $1 OR source_device_id = $1)', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM telematics_events WHERE (device_id = $1 OR source_device_id = $1)', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM telemetry_history WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM driving_sessions WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM vehicle_status WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query(
    `INSERT INTO geotab_devices (id, name, fleet_number, license_plate)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, fleet_number = EXCLUDED.fleet_number, license_plate = EXCLUDED.license_plate`,
    [DEVICE_ID, `${FLEET} - ${REG}`, FLEET, REG]
  );

  console.log('== [A] 85 needs >=2 min sustained ==');
  await tick('tick0 firstSeen @86', snap({ spd: 86 }));
  let row = await vs();
  check('row created with episode clock running', !!row?.speed_85_episode_since, row && row.speed_85_episode_since);
  check('not flagged on first sighting', row?.speed_85_alerted === false);
  check('no group yet', Object.keys(await groupsByType()).length === 0);

  await tick('tick1 @86 (age ~15s)', snap({ spd: 86 }));
  check('still no group before 2 min', Object.keys(await groupsByType()).length === 0);

  await setNextEpisodeAge(121);
  await tick('tick2 @86 (episode stamped 121s ago)', snap({ spd: 86 }));
  let g = await groupsByType();
  check('85 group fired after 121s', (g[S85_NAME]?.n || 0) === 1, JSON.stringify(g));
  const e85 = await lastEvent(SPEED85);
  const d85 = e85?.distance ?? null;
  check('distance recorded on the 85 event', d85 != null && Number(d85) > 0, d85);
  check('distance covers the ~2 min episode (~0.7km)', Number(d85) > 0.5 && Number(d85) < 1.0, d85);
  check('85 archive duration >= 120s', Number(e85?.duration_seconds) >= 120, e85?.duration_seconds);
  const g85 = await latestGroup(S85_NAME);
  check('85 group keeps latest duration >= 120s', Number(g85?.duration_seconds) >= 120, g85?.duration_seconds);
  check('85 group keeps distance', Number(g85?.distance_km) === Number(d85), JSON.stringify(g85));
  const m85 = (await query('SELECT distance_km, duration_seconds FROM alerts WHERE alarm_type = $1 AND device_id = $2 ORDER BY alarm_ts DESC LIMIT 1', [S85_NAME, FLEET])).rows[0];
  check('85 member keeps distance and duration', Number(m85?.distance_km) === Number(d85) && Number(m85?.duration_seconds) >= 120, JSON.stringify(m85));

  await tick('tick3 @86 (still speeding)', snap({ spd: 86 }));
  g = await groupsByType();
  check('no duplicate 85 group while held', (g[S85_NAME]?.n || 0) === 1, JSON.stringify(g));

  console.log('== [B] any dip below 85 restarts the clock (strict) ==');
  await tick('tick4 @80 (dip)', snap({ spd: 80 }));
  row = await vs();
  check('dip cleared the episode clock', row?.speed_85_episode_since == null, row?.speed_85_episode_since);
  await tick('tick5 @86 (back over)', snap({ spd: 86 }));
  row = await vs();
  check('episode clock restarted on re-cross', row?.speed_85_episode_since != null);
  g = await groupsByType();
  check('no second group yet (clock only just restarted)', (g[S85_NAME]?.n || 0) === 1, JSON.stringify(g));

  console.log('== [C] re-arm: 30s below → new run → new 2-min cycle ==');
  await query('UPDATE vehicle_status SET speed_85_dwell_since = NOW() - INTERVAL \'31 seconds\' WHERE device_id = $1', [DEVICE_ID]);
  await tick('tick6 @80 (dwell matures)', snap({ spd: 80 }));
  row = await vs();
  check('alert flag re-armed after 30s below', row?.speed_85_alerted === false);
  // Mirror the operator: the first group is resolved before the next run matures,
  // so the next fire must create a NEW group (not bump the old one).
  await query(
    "UPDATE alert_groups SET resolved = TRUE, resolved_at = NOW() WHERE (device_id = $1 OR source_device_id = $1) AND alarm_type = $2 AND resolved = FALSE",
    [DEVICE_ID, S85_NAME]
  );
  await tick('tick7 @86 (new run starts)', snap({ spd: 86 }));
  row = await vs();
  check('new run: no instant fire at 15s (sustain required)', row?.speed_85_alerted === false);
  g = await groupsByType();
  check('resolved group stays alone (no resurrection)', (g[S85_NAME]?.n || 0) === 1, JSON.stringify(g));
  await setNextEpisodeAge(121);
  await tick('tick8 @86 (2nd run matured)', snap({ spd: 86 }));
  g = await groupsByType();
  check('second run raises a SECOND 85 group (after resolve)', (g[S85_NAME]?.n || 0) === 2, JSON.stringify(g));
  const d85b = await lastEventDistance(SPEED85);
  check('2nd run distance ≈ 2 min run (~2.5km)', Number(d85b) > 2.2 && Number(d85b) < 3.0, d85b);

  console.log('== [D] 90 stays instant ==');
  await tick('tick9 @92 (first 90 sample)', snap({ spd: 92 }));
  g = await groupsByType();
  check('90 group created on the FIRST sample', (g[S90_NAME]?.n || 0) === 1, JSON.stringify(g));
  const e90 = await lastEvent(SPEED90);
  check('90 event stores zero distance at fire', Number(e90?.distance) === 0, e90?.distance);
  check('90 event stores zero duration at fire', Number(e90?.duration_seconds) === 0, e90?.duration_seconds);
  const g90 = await latestGroup(S90_NAME);
  check('90 group stores zero distance/duration', Number(g90?.distance_km) === 0 && Number(g90?.duration_seconds) === 0, JSON.stringify(g90));
  check('90 superseded 85 (still two 85 groups)', (g[S85_NAME]?.n || 0) === 2, JSON.stringify(g));

  console.log('== [E] fatigue alert carries session distance ==');
  await query(
    `UPDATE vehicle_status
        SET is_driving = TRUE,
            driving_since = NOW() - INTERVAL '3 hours 5 minutes',
            current_state_duration = INTERVAL '3 hours 5 minutes',
            fatigue_alerted_thresholds = '[]'
      WHERE device_id = $1`,
    [DEVICE_ID]
  );
  await tick('tick10 driving @80, dur 03:05', snap({ spd: 80, dur: '03:05:00' }));
  g = await groupsByType();
  check('3h fatigue group fired', (g[F3_NAME]?.n || 0) === 1, JSON.stringify(g));
  const dF = await lastEventDistance(FATIGUE3H);
  check('fatigue event carries session distance (>2km)', Number(dF) > 2, dF);

  console.log('== [F] pure helpers ==');
  const kmPerDeg = poller.haversineKm(0, 0, 1, 0);
  check('haversine: 1° latitude ≈ 111.19 km', kmPerDeg > 111.0 && kmPerDeg < 111.35, kmPerDeg);
  const noWindow = await poller.distanceOverTrail(DEVICE_ID, null, new Date().toISOString());
  check('distanceOverTrail(null window) → null (no data, not 0)', noWindow === null, noWindow);

  const final = await groupsByType();
  console.log('groups:', JSON.stringify(final));
  const sessions = (await query('SELECT count(*)::int n FROM driving_sessions WHERE device_id = $1', [DEVICE_ID])).rows[0].n;
  check('one driving session only (no churn)', sessions === 1, sessions);

  // cleanup (local DB only)
  await query('DELETE FROM alerts WHERE (device_id = $1 OR source_device_id = $1)', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM alert_groups WHERE (device_id = $1 OR source_device_id = $1)', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM telematics_events WHERE (device_id = $1 OR source_device_id = $1)', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM telemetry_history WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM driving_sessions WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM vehicle_status WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM geotab_devices WHERE id = $1', [DEVICE_ID]).catch(() => {});

  console.log(`speed-sustain: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
