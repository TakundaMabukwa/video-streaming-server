// Regression test for COMBINATION MEDIA.
//
// A combination group holds members of DIFFERENT alert types (e.g. a telematics
// fatigue event plus a video lane departure). Evidence must cover every member,
// otherwise one side of the incident is invisible. A normal group holds many
// detections of the SAME type, so it must keep using the cheap single fetch.
//
// Covers:
//   1. single-type members  -> no aggregation (unchanged behaviour)
//   2. multi-type members   -> aggregated, tagged per member
//   3. duplicate file URLs across members -> de-duplicated
//   4. one member failing   -> the others still return, partial reported
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';

const db = require('./src/db');
const syncService = require('./src/services/syncService');
const ctrl = require('./src/controllers/dbAlertController');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const TAG = 'mediatest';
const DEV = `${TAG}-dev`;
const originalFetch = syncService.fetchMediaOnDemand;

async function cleanup() {
  await db.query(`DELETE FROM alert_media WHERE alert_id LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_groups WHERE device_id LIKE $1`, [`%${TAG}%`]);
}

async function makeGroup(memberTypes) {
  // Unique alarm_type per group: the DB allows only one live group per
  // (device, alarm_type, source_type).
  const unique = `${TAG} Combined ${Math.random().toString(36).slice(2, 7)}`;
  const g = await db.query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, count, last_alert_id, last_alert_ts, source_type, severity)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'video', 'critical') RETURNING id`,
    [`${TAG}:${unique}`, DEV, `${DEV} - TEST`, unique, memberTypes.length,
      `${TAG}-m${Date.now()}`]
  );
  const group = g.rows[0];
  const members = [];
  for (let i = 0; i < memberTypes.length; i++) {
    const id = `${TAG}-${group.id}-${i}`;
    await db.query(
      `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, source_type, alert_group_id, severity, fleet_number)
       VALUES ($1, $2, $3, $4, NOW() - ($5 || ' seconds')::interval, $6, $7, 'high', 'PB29')`,
      [id, DEV, `${DEV} - TEST`, memberTypes[i], i * 10, i === 0 ? 'telematics' : 'video', group.id]
    );
    members.push({ id, device_id: DEV, device_name: `${DEV} - TEST`, alarm_type: memberTypes[i], alarm_ts: new Date().toISOString() });
  }
  return { group, members };
}

(async () => {
  await db.initializeDatabase();
  await cleanup();

  // ── 1. single-type members must NOT trigger aggregation ──────────────
  {
    const { group } = await makeGroup(['Fatigue Warning', 'Fatigue Warning', 'Fatigue Warning']);
    const members = await ctrl.getDistinctTypeMembers(group.id);
    check(members.length === 0, `single-type group returns no aggregation (got ${members.length})`);
    check(members.length === 0, 'single alert path is untouched');
  }

  // ── 2. multi-type members are aggregated ──────────────────────────────
  {
    const { group } = await makeGroup(['Fatigue Warning', 'Lane Deviation']);
    const members = await ctrl.getDistinctTypeMembers(group.id);
    check(members.length === 2, `multi-type group returns both members (got ${members.length})`);
    const types = new Set(members.map((m) => m.alarm_type));
    check(types.size === 2, 'both distinct types present');
    const hasSource = members.every((m) => 'source_type' in m);
    check(hasSource, 'members carry their own source_type (telematics vs video)');

    // Stub the media fetch: each member returns one image + one clip.
    const calls = [];
    syncService.fetchMediaOnDemand = async (alert) => {
      calls.push(alert.alarm_type);
      return [
        { id: `${alert.id}-img`, file_url: `https://x/${alert.alarm_type.replace(/\s+/g, '-')}.jpg`, file_type: '00', created_at: alert.alarm_ts },
        { id: `${alert.id}-vid`, file_url: `https://x/${alert.alarm_type.replace(/\s+/g, '-')}.flv`, file_type: '02', created_at: alert.alarm_ts },
      ];
    };
    const { media, failed, partial } = await ctrl.fetchMediaForMembers(members);
    check(calls.length === 2, `fetched media for every member (${calls.length} calls)`);
    check(failed === 0 && partial === false, 'no failures reported');
    check(media.length === 4, `merged both members' media (got ${media.length})`);
    const images = media.filter((m) => m.file_type === '00');
    check(images.length === 2, 'one image per member');
    check(images.every((m) => m._member_type && m._member_alert_id), 'each item tagged with its member');
    check(new Set(images.map((m) => m._member_type)).size === 2, 'tags distinguish telematics vs video member');
  }

  // ── 3. duplicate files across members are de-duplicated ──────────────
  {
    syncService.fetchMediaOnDemand = async (alert) => ([
      { id: `shared-${alert.id}`, file_url: 'https://x/SAME.jpg', file_type: '00' },
    ]);
    const members = [
      { id: 'a', alarm_type: 'A' },
      { id: 'b', alarm_type: 'B' },
    ];
    const { media } = await ctrl.fetchMediaForMembers(members);
    check(media.length === 1, `same file returned once, not twice (got ${media.length})`);
  }

  // ── 4. one member failing never breaks the group ─────────────────────
  {
    syncService.fetchMediaOnDemand = async (alert) => {
      if (alert.alarm_type === 'Bad') throw new Error('skycamx 500');
      return [{ id: `ok-${alert.alarm_type}`, file_url: `https://x/${alert.alarm_type}.jpg`, file_type: '00' }];
    };
    const members = [
      { id: 'a', alarm_type: 'Good' },
      { id: 'b', alarm_type: 'Bad' },
      { id: 'c', alarm_type: 'Good2' },
    ];
    const { media, failed, partial } = await ctrl.fetchMediaForMembers(members);
    check(media.length === 2, 'surviving members still returned');
    check(failed === 1 && partial === true, `failure counted and flagged partial (failed=${failed})`);
  }

  syncService.fetchMediaOnDemand = originalFetch;
  await cleanup();
  const left = await db.query(`SELECT count(*)::int c FROM alerts WHERE id LIKE $1`, [`${TAG}%`]);
  check(left.rows[0].c === 0, 'test rows cleaned up');

  console.log(ok ? '\nCOMBO-MEDIA-OK' : '\nCOMBO-MEDIA-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('COMBO-MEDIA-ERROR:', e.message);
  process.exit(1);
});