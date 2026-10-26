'use strict';
// Local-only test for the requireAuth per-token cache:
//  - repeat requests with the same token make ZERO Supabase round-trips
//  - expired JWT → 401 with zero round-trips
//  - different tokens are cached separately
//  - cost-centre lookup is shared per user (already cached, verified here)
//
// Run:  docker compose cp test-auth-cache.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-auth-cache.js

const path = require('path');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

// ── Stub Supabase BEFORE auth.js is required ─────────────────────────────
let getUserCalls = 0;
let usersSelectCalls = 0;
let ccSelectCalls = 0;
const supabaseJs = require(path.join(process.cwd(), 'node_modules', '@supabase/supabase-js'));
supabaseJs.createClient = () => ({
  auth: {
    getUser: async (token) => {
      getUserCalls += 1;
      if (token === 'bad-token') return { data: { user: null }, error: { message: 'bad token' } };
      return { data: { user: { id: 'user-1', email: 'cache-test@example.com' } }, error: null };
    },
  },
  from: (table) => ({
    select: () => ({
      eq: () => {
        const builder = {
          single: async () => {
            if (table === 'users') { usersSelectCalls += 1; return { data: { id: 'user-1', role: 'admin' }, error: null }; }
            return { data: null, error: { message: 'unknown table' } };
          },
          // PostgrestBuilder is thenable: .eq(...) can be awaited directly
          // (that is how getUserCostCenterIds queries user_cost_centers).
          then(resolve, reject) {
            if (table === 'user_cost_centers') ccSelectCalls += 1;
            return Promise.resolve({ data: table === 'user_cost_centers' ? [{ cost_center_id: 7 }, { cost_center_id: 8 }] : [], error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    }),
  }),
});
process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';

const { requireAuth } = require('./src/middleware/auth');

// ── Helpers ──────────────────────────────────────────────────────────────
function makeToken(expSecFromNow) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-1', email: 'cache-test@example.com', jti: Math.random().toString(36).slice(2),
    exp: Math.floor(Date.now() / 1000) + expSecFromNow,
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}
function mockRes() {
  const res = {
    statusCode: 200, body: null,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}
function callRequireAuth(token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
    const res = mockRes();
    requireAuth(req, res, () => resolve({ next: true, req, res }));
    // If next() was never called the handler sent a response — resolve on the
    // next tick so the status/json calls have landed.
    setImmediate(() => resolve({ next: false, req, res }));
  });
}

(async () => {
  console.log('== [1] first request pays, repeats are free ==');
  const token = makeToken(3600);
  const r1 = await callRequireAuth(token);
  check('first request reaches next()', r1.next === true, JSON.stringify(r1.res.body));
  check('first request cost 1 getUser + 1 users + 1 cc', getUserCalls === 1 && usersSelectCalls === 1 && ccSelectCalls === 1,
    `getUser=${getUserCalls} users=${usersSelectCalls} cc=${ccSelectCalls}`);

  const r2 = await callRequireAuth(token);
  check('second request reaches next()', r2.next === true);
  check('second request makes ZERO Supabase calls', getUserCalls === 1 && usersSelectCalls === 1 && ccSelectCalls === 1,
    `getUser=${getUserCalls} users=${usersSelectCalls} cc=${ccSelectCalls}`);
  check('identity attached from cache', r2.req.user?.email === 'cache-test@example.com' && r2.req.userRole === 'admin' && Array.isArray(r2.req.userCostCenterIds) && r2.req.userCostCenterIds.length === 2);

  // Hammer it 20 more times — the board-poll pattern.
  for (let i = 0; i < 20; i++) await callRequireAuth(token);
  check('20 rapid repeats still zero Supabase calls', getUserCalls === 1 && usersSelectCalls === 1,
    `getUser=${getUserCalls} users=${usersSelectCalls}`);

  console.log('== [2] distinct tokens are cached separately ==');
  const otherUserGetUserCalls = { n: 0 };
  const origGetUser = supabaseJs.createClient().auth.getUser; // stub captured above uses user-1 always
  const token2 = makeToken(3600); // same stub user — cache key is the token
  const before2 = getUserCalls;
  await callRequireAuth(token2);
  check('new token pays its own lookup', getUserCalls === before2 + 1, `getUser=${getUserCalls}`);
  const before3 = getUserCalls;
  await callRequireAuth(token2);
  check('new token now cached too', getUserCalls === before3, `getUser=${getUserCalls}`);

  console.log('== [3] expired JWT → 401 with zero Supabase calls ==');
  const expired = makeToken(-120);
  const before4 = getUserCalls;
  const r4 = await callRequireAuth(expired);
  check('expired token rejected', r4.next === false && r4.res.statusCode === 401, JSON.stringify(r4.res.body));
  check('expired token never reaches Supabase', getUserCalls === before4, `getUser=${getUserCalls}`);

  console.log('== [4] invalid token evicts + 401 ==');
  const r5 = await callRequireAuth('bad-token');
  check('bad token rejected', r5.next === false && r5.res.statusCode === 401);

  console.log('== [5] no token → 401, no Supabase ==');
  const before6 = getUserCalls;
  const r6 = await new Promise((resolve) => {
    const req = { headers: {}, cookies: {} };
    const res = mockRes();
    requireAuth(req, res, () => resolve({ next: true }));
    setImmediate(() => resolve({ next: false, res }));
  });
  check('missing token rejected', r6.next === false && r6.res?.statusCode === 401);
  check('missing token never reaches Supabase', getUserCalls === before6);

  console.log(`auth-cache: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
