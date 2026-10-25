'use strict';
// Local-only unit tests for the sync freshness + media window partitions.
// Pure helpers — no network, no DB writes beyond reading nothing.
//
// Run:  docker compose cp test-sync-freshness.js server:/app/
//       MSYS_NO_PATHCONV=1 docker compose exec -T server node /app/test-sync-freshness.js

const {
  partitionFreshRecords,
  filterMediaToWindow,
  parseWindowMs,
} = require('./src/services/syncService');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${detail}`}`); }
}

const nowMs = Date.parse('2026-10-25T12:00:00Z');
const minutes = (n) => nowMs - n * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

console.log('== parseWindowMs ==');
const p = parseWindowMs('2026-10-25 10:00:00');
check('utc "YYYY-MM-DD HH:MM:SS" parses', p === Date.parse('2026-10-25T10:00:00Z'), p);
check('already-ISO string passes through', parseWindowMs('2026-10-25T10:00:00Z') === Date.parse('2026-10-25T10:00:00Z'));
check('garbage → null', parseWindowMs('not-a-date') === null);
check('empty → null', parseWindowMs('') === null && parseWindowMs(null) === null);

console.log('== partitionFreshRecords: inside window kept ==');
let res = partitionFreshRecords(
  [{ id: 'a', alarmTs: iso(minutes(1)) }],
  { startMs: minutes(10), maxAgeMs: 120 * 60 * 1000, nowMs },
);
check('record 1min old kept', res.kept.length === 1 && res.stale === 0 && res.tooOld === 0, JSON.stringify(res));

console.log('== partitionFreshRecords: pre-watermark dropped ==');
res = partitionFreshRecords(
  [{ id: 'b', alarmTs: iso(minutes(30)) }],
  { startMs: minutes(10), maxAgeMs: 120 * 60 * 1000, nowMs },
);
check('record older than HWM start dropped', res.kept.length === 0 && res.stale === 1, JSON.stringify(res));

console.log('== partitionFreshRecords: over age cap dropped ==');
res = partitionFreshRecords(
  [{ id: 'c', alarmTs: iso(minutes(300)) }],
  { startMs: null, maxAgeMs: 120 * 60 * 1000, nowMs },
);
check('record 5h old dropped by age cap (no start filter)', res.kept.length === 0 && res.tooOld === 1, JSON.stringify(res));

console.log('== partitionFreshRecords: missing ts kept ==');
res = partitionFreshRecords(
  [{ id: 'd' }, { id: 'e', alarmTs: null }],
  { startMs: minutes(10), maxAgeMs: 120 * 60 * 1000, nowMs },
);
check('records without alarmTs are kept (never silently lost)', res.kept.length === 2, JSON.stringify(res));

console.log('== partitionFreshRecords: snake_case key works ==');
res = partitionFreshRecords(
  [{ id: 'f', alarm_ts: iso(minutes(30)) }],
  { startMs: minutes(10), maxAgeMs: 120 * 60 * 1000, nowMs },
);
check('alarm_ts (snake_case) also judged', res.kept.length === 0 && res.stale === 1, JSON.stringify(res));

console.log('== partitionFreshRecords: boundary ==');
res = partitionFreshRecords(
  [{ id: 'g', alarmTs: iso(minutes(10)) }],
  { startMs: minutes(10), maxAgeMs: 120 * 60 * 1000, nowMs },
);
check('record exactly at startMs kept (not < start)', res.kept.length === 1, JSON.stringify(res));

console.log('== filterMediaToWindow: in-window kept ==');
const wStart = minutes(30);
const wEnd = minutes(29);
const files = [
  { id: 'in', alarm_time: iso(minutes(30)), file_url: 'x' },
  { id: 'old', alarm_time: iso(minutes(200)), file_url: 'y' },   // way before window → drop
  { id: 'future', alarm_time: iso(minutes(5)), file_url: 'z' },  // way after window → drop
  { id: 'nots', file_url: 'replay' },                            // no timestamp → keep
];
const kept = filterMediaToWindow(files, wStart, wEnd);
check('in-window file kept, stale/future dropped, timestamp-less kept',
  kept.map((f) => f.id).sort().join(',') === 'in,nots', JSON.stringify(kept.map((f) => f.id)));

console.log('== filterMediaToWindow: 5-minute tolerance ==');
const nearOld = filterMediaToWindow([{ id: 'near', created_at: iso(minutes(34)) }], wStart, wEnd);
check('file 4min before window kept (inside tolerance)', nearOld.length === 1);
const farOld = filterMediaToWindow([{ id: 'far', created_at: iso(minutes(40)) }], wStart, wEnd);
check('file 10min before window dropped', farOld.length === 0);

console.log('== filterMediaToWindow: no usable window → passthrough ==');
check('null start → all kept', filterMediaToWindow(files, NaN, wEnd).length === files.length);
check('no files → empty', filterMediaToWindow(null, wStart, wEnd).length === 0);

console.log(`sync-freshness: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
