const { Pool } = require('pg');
const config = require('../config/config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 45000,
  // Client-side bound: a query whose socket died silently rejects instead of
  // hanging forever (this is what stalls a poll with no log line).
  query_timeout: 60000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Surface idle-client errors instead of letting them crash or vanish.
pool.on('error', (err) => {
  console.error('[pool] idle client error:', err.message);
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function getClient() {
  return await pool.connect();
}

async function closePool() {
  await pool.end();
}

module.exports = { pool, query, getClient, closePool };
