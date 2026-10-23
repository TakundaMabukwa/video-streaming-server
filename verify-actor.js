// Regression test for CLOSE ATTRIBUTION.
//
// The browser could not always read its own Supabase session, so the resolve
// modal fell back to the literal string "unknown_user" and that was written to
// alert_groups.resolved_by. Attribution is now server-authoritative: the caller
// is already authenticated by requireAuth, so the server uses ITS OWN identity
// whenever the client sends nothing usable.
//
// Covers:
//   1. client sends a real email        -> that email is used
//   2. client sends "unknown_user"      -> authenticated user's email is used
//   3. client sends nothing             -> authenticated user's email is used
//   4. client sends a junk placeholder  -> authenticated user's email is used
//   5. no authenticated identity at all -> null, never a placeholder string
//   6. the value actually lands in the DB row
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:SRS%40981234%23*@127.0.0.1:5433/eps_alerts';

const db = require('./src/db');

let ok = true;
const check = (c, m) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const TAG = 'actortest';
const DEV = `${TAG}-dev`;

// Mirror of the controller's resolveActor(): the server-side rule under test.
const UNKNOWN_ACTORS = new Set(['unknown_user', 'unknown', 'unknown user', 'null', 'undefined', '']);
function resolveActor(req, provided) {
  const candidate = String(provided ?? '').trim();
  if (candidate && !UNKNOWN_ACTORS.has(candidate.toLowerCase())) return candidate;
  const email = String(req?.user?.email || '').trim();
  if (email) return email;
  const metaEmail = String(req?.user?.user_metadata?.email || '').trim();
  if (metaEmail) return metaEmail;
  const id = String(req?.user?.id || '').trim();
  if (id) return id;
  return null;
}

const authedReq = (email, id = 'user-uuid-1') => ({ user: { email, id, user_metadata: { email } } });

(async () => {
  await db.initializeDatabase();
  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_groups WHERE device_id LIKE $1`, [`%${TAG}%`]);

  // 1. A real client-supplied identity wins.
  check(resolveActor(authedReq('ops@srs.co.za'), 'controller@srs.co.za') === 'controller@srs.co.za',
    'a real client identity is used');

  // 2. The literal placeholder must never survive.
  check(resolveActor(authedReq('ops@srs.co.za'), 'unknown_user') === 'ops@srs.co.za',
    '"unknown_user" is replaced by the authenticated user');

  // 3. Nothing sent.
  check(resolveActor(authedReq('ops@srs.co.za'), undefined) === 'ops@srs.co.za',
    'a missing client identity falls back to the authenticated user');

  // 4. Other junk placeholders.
  for (const junk of ['unknown', 'Unknown User', 'null', 'undefined', '   ', '']) {
    check(resolveActor(authedReq('ops@srs.co.za'), junk) === 'ops@srs.co.za',
      `placeholder ${JSON.stringify(junk)} is replaced`);
  }

  // 5. No authenticated identity -> null, never a lie.
  check(resolveActor({ user: null }, 'unknown_user') === null,
    'with no authenticated identity the actor is null, not a placeholder');
  check(resolveActor({}, undefined) === null, 'an empty request resolves to null');

  // user_metadata fallback, then user id.
  check(resolveActor({ user: { id: 'u-9', user_metadata: { email: 'meta@srs.co.za' } } }, null) === 'meta@srs.co.za',
    'falls back to user_metadata email');
  check(resolveActor({ user: { id: 'u-9' } }, null) === 'u-9',
    'falls back to the user id');

  // 6. The resolved value really lands in the DB, and cascades to members.
  const g = await db.query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, count, last_alert_id, last_alert_ts, source_type, severity)
     VALUES ($1, $2, $3, $4, 1, $5, NOW(), 'video', 'high') RETURNING id`,
    [`${TAG}:1`, DEV, `${DEV} - TEST`, `${TAG} Alert`, `${TAG}-m1`]
  );
  const groupId = g.rows[0].id;
  await db.query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, source_type, alert_group_id)
     VALUES ($1, $2, $3, $4, NOW(), 'video', $5)`,
    [`${TAG}-m1`, DEV, `${DEV} - TEST`, `${TAG} Alert`, groupId]
  );

  const actor = resolveActor(authedReq('ops@srs.co.za'), 'unknown_user');
  await db.resolveAlertGroupById(groupId, { resolved: true, resolved_by: actor });
  const row = await db.query('SELECT resolved, resolved_by FROM alert_groups WHERE id = $1', [groupId]);
  check(row.rows[0].resolved_by === 'ops@srs.co.za', `DB row carries the real email (got ${row.rows[0].resolved_by})`);
  check(row.rows[0].resolved_by !== 'unknown_user', 'no placeholder in the DB');

  const member = await db.query('SELECT resolved, resolved_by FROM alerts WHERE alert_group_id = $1', [groupId]);
  check(member.rows[0].resolved_by === 'ops@srs.co.za', 'closure cascaded to the member with the real email');

  await db.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM alert_groups WHERE device_id LIKE $1`, [`%${TAG}%`]);
  const left = await db.query(`SELECT count(*)::int c FROM alert_groups WHERE device_id LIKE $1`, [`%${TAG}%`]);
  check(left.rows[0].c === 0, 'test rows cleaned up');

  console.log(ok ? '\nACTOR-OK' : '\nACTOR-FAILED');
  await db.closePool();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ACTOR-ERROR:', e);
  process.exit(1);
});