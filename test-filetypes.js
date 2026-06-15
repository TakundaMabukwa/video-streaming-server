const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const BASE = 'https://mettahub.mettaxiot.com/gps/v2/openapi';

async function main() {
  // Get token
  const tokenRes = await axios.post(`${BASE}/system/createToken`, {
    apiKey: process.env.VIDEO_API_KEY,
    apiSecret: process.env.VIDEO_API_SECRET
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  const token = tokenRes.data.data;

  // Get some alerts with different types from DB
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const result = await pool.query(`
    SELECT DISTINCT ON (a.alarm_type) a.id, a.alarm_type, a.alarm_ts
    FROM alerts a
    ORDER BY a.alarm_type, a.alarm_ts DESC
    LIMIT 20
  `);
  pool.end();

  for (const row of result.rows) {
    try {
      const res = await axios.post(`${BASE}/alarm/file/id`, { alarmId: row.id }, {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      const files = res.data.data || [];
      const types = files.map(f => ({ type: f.fileType, size: f.fileSize }));
      const hasVideo = files.some(f => f.fileType === '02');
      const hasScreenshot = files.some(f => f.fileType === '00');
      console.log(`${row.alarm_type.padEnd(30)} id=${row.id.slice(-6)} files=${files.length} screenshots=${hasScreenshot} video=${hasVideo} types=${JSON.stringify(types)}`);
    } catch(e) {
      console.log(`${row.alarm_type.padEnd(30)} id=${row.id.slice(-6)} ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
main().catch(console.error);
