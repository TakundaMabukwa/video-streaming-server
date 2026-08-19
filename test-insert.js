const db = require('./src/db');
async function test() {
  try {
    const r = await db.query('INSERT INTO alert_group_configs (name, severity, description) VALUES ($1, $2, $3) RETURNING *', ['Test', 'CRITICAL', 'test']);
    console.log('SUCCESS:', JSON.stringify(r.rows));
  } catch(e) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
}
test();
