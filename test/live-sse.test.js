'use strict';
// Local-only: verifies the SSE hub delivers alert changes, telemetry batches,
// camera status and presence over one stream.
const db = require('../src/db');
const sseHub = require('../src/live/sseHub');
const livePresence = require('../src/live/presence');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

function fakeRes() {
  const events = [];
  const res = {
    headers: {},
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; },
    flushHeaders() {},
    write(chunk) { events.push(String(chunk)); return true; },
    end() { this.ended = true; },
    on() { return this; },
    events,
    parsed() {
      return events
        .filter((x) => x.startsWith('data: '))
        .map((x) => {
          try { return JSON.parse(x.slice(6).trim()); } catch { return null; }
        })
        .filter(Boolean);
    },
  };
  return res;
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = fn();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

(async () => {
  await db.initializeDatabase();
  sseHub.start();
  await new Promise((r) => setTimeout(r, 300));

  const res = fakeRes();
  const client = await sseHub.addClient({
    res,
    identity: { id: 'test-user', email: 'test@srs.local' },
    ccIds: [],
    sinceRevision: 0,
  });
  check('SSE headers are event-stream', String(res.headers['Content-Type'] || '').includes('text/event-stream'), JSON.stringify(res.headers));
  check('client receives CONNECTED/READY', !!(await waitFor(() => res.parsed().find((e) => e.type === 'READY'), 2000)));

  const suffix = Date.now().toString(36);
  const groupKey = `sse:${suffix}`;
  const inserted = await db.query(
    `INSERT INTO alert_groups
       (group_key, device_id, device_name, alarm_type, alarm_text, count,
        last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
     VALUES ($1, 'EX55', 'EX55 - LDR065MP', 'Heavy Duty Max Speeding 85km/h',
             'Speed 86 km/h exceeded 85 km/h', 1, 'dst-sse-1', NOW(),
             -26.1, 28.1, 86, 'telematics', 'high', 'EX55')
     RETURNING id, revision`,
    [groupKey]
  );
  const groupId = inserted.rows[0].id;
  const openEvent = await waitFor(() => res.parsed().find((e) => e.type === 'ALERT_DELTA' && String(e.id) === String(groupId)));
  check('open alert arrives as ALERT_DELTA', !!openEvent && openEvent.action === 'UPSERT', JSON.stringify(openEvent));

  await db.query(
    `UPDATE alert_groups SET resolved = TRUE, status = 'resolved', resolved_at = NOW(), resolved_by = 'tester' WHERE id = $1`,
    [groupId]
  );
  const closedEvent = await waitFor(() => res.parsed().find((e) => e.type === 'ALERT_CLOSED' && String(e.id) === String(groupId)));
  check('close arrives as ALERT_CLOSED', !!closedEvent && closedEvent.resolved === true, JSON.stringify(closedEvent));

  sseHub.publishTelemetry({ fleet_number: 'EX55', device_id: 'b651', speed: 60, lat: -26.1, lon: 28.1, last_log_time: new Date().toISOString() });
  sseHub.publishTelemetry({ fleet_number: 'EX55', device_id: 'b651', speed: 72, lat: -26.1, lon: 28.1, last_log_time: new Date().toISOString() });
  const telemetry = await waitFor(() => res.parsed().find((e) => e.type === 'TELEMETRY_UPDATE'), 2500);
  check('telemetry is batched', !!telemetry && Array.isArray(telemetry.vehicles) && telemetry.vehicles.length === 1, JSON.stringify(telemetry));
  check('telemetry batch keeps latest value', telemetry?.vehicles?.[0]?.speed === 72, JSON.stringify(telemetry));

  sseHub.publishCamera({ fleet_number: 'EX55', status: 'offline', last_screenshot: null });
  const camera = await waitFor(() => res.parsed().find((e) => e.type === 'CAMERA_STATUS'), 1500);
  check('camera status arrives', !!camera && camera.status === 'offline', JSON.stringify(camera));

  const presence = livePresence.heartbeat({ fleetNumber: 'EX55', alertGroupId: groupId, user: 'ops@srs.local', action: 'ENTER' });
  sseHub.publishPresence(presence);
  const presenceEvent = await waitFor(() => res.parsed().find((e) => e.type === 'PRESENCE_UPDATE' && e.viewing_user === 'ops@srs.local'), 1500);
  check('presence arrives at fleet + alert level', !!presenceEvent && presenceEvent.fleet_number === 'EX55' && String(presenceEvent.alert_group_id) === String(groupId), JSON.stringify(presenceEvent));

  await sseHub.stop();
  await db.closePool();
  console.log(`live-sse: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  try { await sseHub.stop(); } catch {}
  try { await db.closePool(); } catch {}
  process.exit(2);
});
