'use strict';
// Local-only test runner. Requires a disposable local DATABASE_URL.
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const env = { ...process.env };
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a disposable local DB)');
  process.exit(2);
}

function run(file) {
  console.log(`\n=== ${file} ===`);
  execFileSync(process.execPath, [path.join(root, file)], { stdio: 'inherit', env });
}

function reset() {
  execFileSync(process.execPath, [path.join(root, 'test/reset.js')], { stdio: 'inherit', env });
}

// Pure tests first.
run('test/policy.test.js');
run('test-fatigue-plan.js');
run('test/zone-notifications.test.js');

// Integration tests each start from a clean, seeded schema.
reset();
run('test-fatigue-poller.js');

reset();
run('test-speed-sustain.js');

reset();
run('test-alert-cooldown.js');

reset();
run('test-ncr-integrity.js');

reset();
run('test-sync-freshness.js');

reset();
run('test/revision-notify.test.js');

reset();
run('test/live-sse.test.js');

// identity-auth resets the schema itself.
run('test/identity-auth.test.js');
run('test/alert-center.test.js');

console.log('\nAll local tests passed.');
