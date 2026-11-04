'use strict';
// Local-only: recreate the test schema and seed the shared fixtures.
const { resetSchema } = require('./setup');
const { seed } = require('./seed');
const db = require('../src/db');

(async () => {
  await resetSchema();
  await seed();
  await db.closePool();
})().catch((err) => { console.error(err); process.exit(1); });
