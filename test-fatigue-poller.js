'use strict';
// Emulates the DeviceStatusInfo poller locally against SCRIPTED Geotab
// snapshots (https to my.geotab.com is faked in-process; everything else —
// DB, registry guards, definition gates, group upsert — is the real code).
//
// Scenario proves, end to end:
//   - first sighting pre-seeds thresholds the clock already passed
//   - an already-served 3h threshold does NOT fire again while the clock is
//     still past 180m (the "resolved, back in 5 minutes" bug)
//   - a stale/offline snapshot claiming isDriving=false is IGNORED
//     (no driving-session churn, no memory wipe)
//   - speed episode flags survive that flap too
//   - a genuine clock restart re-arms the batch → next run fires once
//   - a lost vehicle_status row replays nothing (baseline pre-seed)
//
// Run inside the server container:
//   docker compose cp test-fatigue-poller.js server:/app/
//   MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-fatigue-poller.js

const https = require('https');
const realRequest = https.request.bind(https);

// ── Fake Geotab transport ──────────────────────────────────────────────────
// Node calls https.request(url, options, cb) here — accept both forms.
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
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
      let payload;
      if (body.method === 'Authenticate') {
        payload = {
          result: {
            credentials: { sessionId: 'test-session', database: 'test', userName: 'test', path: 'https://my.geotab.com' },
          },
        };
      } else {
        payload = { result: nextStatus ? [nextStatus] : [] };
      }
      const text = JSON.stringify(payload);
      const res = {
        statusCode: 200,
        headers: {},
        on(ev, fn) {
          if (ev === 'data') fn(text);
          else if (ev === 'end') fn();
          return res;
        },
      };
      if (cb) cb(res);
    },
  };
  return req;
};

const { query } = require('./src/db/pool');
const poller = require('./src/services/deviceStatusPoller');

const DEVICE_ID = 'TESTFAT01';
const FLEET = 'OT22';       // in fleet_vehicles, no mettax id, no cost centre
const REG = 'LCZ729MP';
const THREE_H = 'a43F6lFwgIUq_gkgmgSX08g';
const FATIGUE_3H_NAME = 'Driver Fatigue - 3 hours'; // local alert_definitions name

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`);
  }
}

function snap({ driving, duration, speed = 80, fresh = true }) {
  return {
    device: { id: DEVICE_ID },
    latitude: 48.8566,
    longitude: 2.3522,
    speed,
    dateTime: fresh ? new Date().toISOString() : new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    isDeviceCommunicating: fresh,
    isDriving: driving,
    currentStateDuration: duration,
  };
}

async function tick(label, status) {
  nextStatus = status;
  await poller.pollDeviceStatus();
  console.log(`  · tick: ${label}`);
}

const vs = async () => (await query('SELECT * FROM vehicle_status WHERE device_id = $1', [DEVICE_ID])).rows[0] || null;
const heldCodes = async (row) => {
  const r = row || (await vs());
  try { return JSON.parse((r && r.fatigue_alerted_thresholds) || '[]'); } catch { return ['<unparsable>']; }
};
const fatigueGroups = async () =>
  (await query('SELECT id, count, resolved FROM alert_groups WHERE device_id = $1 AND alarm_type = $2', [DEVICE_ID, FATIGUE_3H_NAME])).rows;
const allGroups = async () => (await query('SELECT alarm_type, count FROM alert_groups WHERE device_id = $1', [DEVICE_ID])).rows;
const sessions = async () =>
  (await query('SELECT count(*)::int n FROM driving_sessions WHERE device_id = $1', [DEVICE_ID])).rows[0].n;

(async () => {
  console.log('== prep: clean test device ==');
  await query('DELETE FROM alerts WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM alert_groups WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM telematics_events WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM driving_sessions WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query('DELETE FROM vehicle_status WHERE device_id = $1', [DEVICE_ID]).catch(() => {});
  await query(
    `INSERT INTO geotab_devices (id, name, fleet_number, license_plate)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, fleet_number = EXCLUDED.fleet_number, license_plate = EXCLUDED.license_plate`,
    [DEVICE_ID, `${FLEET} - ${REG}`, FLEET, REG]
  );

  console.log('== [S1] first sighting: 03:05 driving ==');
  await tick('firstSeen @ 185m', snap({ driving: true, duration: '03:05:00' }));
  let row = await vs();
  check('row created', !!row);
  check('is_driving stored true', row && row.is_driving === true, row && row.is_driving);
  check('baseline pre-seeds 3h (already crossed)', JSON.stringify(await heldCodes(row)) === JSON.stringify([THREE_H]), JSON.stringify(await heldCodes(row)));
  check('no alert on first sighting', (await fatigueGroups()).length === 0);
  check('one driving session opened', (await sessions()) === 1, await sessions());

  console.log('== [S2] next tick, still driving, 03:06 (clock past 180) ==');
  await tick('held @ 186m', snap({ driving: true, duration: '03:06:00' }));
  check('3h NOT re-fired while held', (await fatigueGroups()).length === 0);
  check('memory unchanged', JSON.stringify(await heldCodes()) === JSON.stringify([THREE_H]), JSON.stringify(await heldCodes()));

  console.log('== [S3] manual speed episode armed, then a STALE offline flap ==');
  await query('UPDATE vehicle_status SET speed_85_alerted = TRUE, speed_90_alerted = TRUE WHERE device_id = $1', [DEVICE_ID]);
  await tick('stale isDriving=false', snap({ driving: false, duration: '00:01:00', speed: 0, fresh: false }));
  row = await vs();
  check('stale snapshot did NOT flip is_driving', row.is_driving === true, row.is_driving);
  check('stale snapshot did NOT end the session', (await sessions()) === 1, await sessions());
  check('stale snapshot did NOT touch fatigue memory', JSON.stringify(await heldCodes(row)) === JSON.stringify([THREE_H]), JSON.stringify(await heldCodes(row)));
  check('stale snapshot did NOT wipe speed flags', row.speed_90_alerted === true && row.speed_85_alerted === true, JSON.stringify([row.speed_85_alerted, row.speed_90_alerted]));

  console.log('== [S4] fresh driving again, 03:07 — the prod bug scenario ==');
  await tick('after flap @ 187m', snap({ driving: true, duration: '03:07:00' }));
  row = await vs();
  check('no new session churn after the flap', (await sessions()) === 1, await sessions());
  check('3h still held (was NOT wiped by the flap)', JSON.stringify(await heldCodes(row)) === JSON.stringify([THREE_H]), JSON.stringify(await heldCodes(row)));
  check('no 3h group re-created after resolve-equivalent flap', (await fatigueGroups()).length === 0);
  check('speed episode flags survived the flap', row.speed_90_alerted === true && row.speed_85_alerted === true, JSON.stringify([row.speed_85_alerted, row.speed_90_alerted]));

  console.log('== [S5] genuine clock restart: 00:05 → batch re-arms ==');
  await tick('clock reset @ 5m', snap({ driving: true, duration: '00:05:00' }));
  row = await vs();
  check('3h re-armed because the clock dropped below 180', JSON.stringify(await heldCodes(row)) === '[]', JSON.stringify(await heldCodes(row)));

  console.log('== [S6] clock crosses 180 again in the new run → ONE new group ==');
  await tick('next batch @ 03:20', snap({ driving: true, duration: '03:20:00' }));
  let g = await fatigueGroups();
  check('3h fired once for the new run', g.length === 1, JSON.stringify(g));
  check('group count is 1', g.length === 1 && Number(g[0].count) === 1, JSON.stringify(g));
  check('memory holds 3h again', JSON.stringify(await heldCodes()) === JSON.stringify([THREE_H]), JSON.stringify(await heldCodes()));

  console.log('== [S7] same run continues: 03:21 ==');
  await tick('held again @ 187m', snap({ driving: true, duration: '03:21:00' }));
  g = await fatigueGroups();
  check('no second group', g.length === 1, JSON.stringify(g));
  check('no count bump', Number(g[0].count) === 1, JSON.stringify(g));

  console.log('== [S8] vehicle_status row lost (failed load / re-onboard) ==');
  await query('DELETE FROM vehicle_status WHERE device_id = $1', [DEVICE_ID]);
  await tick('firstSeen again @ 03:30', snap({ driving: true, duration: '03:30:00' }));
  row = await vs();
  check('row recreated with 3h pre-seeded', JSON.stringify(await heldCodes(row)) === JSON.stringify([THREE_H]), JSON.stringify(await heldCodes(row)));
  check('baseline tick raised nothing', (await fatigueGroups()).length === 1, (await fatigueGroups()).length);

  console.log('== [S9] and the tick after ==');
  await tick('held after restore @ 03:31', snap({ driving: true, duration: '03:31:00' }));
  check('still exactly one 3h group for the whole run', (await fatigueGroups()).length === 1, JSON.stringify(await fatigueGroups()));

  console.log('');
  console.log('groups raised for test device:', JSON.stringify(await allGroups()));
  console.log(`fatigue-poller: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
