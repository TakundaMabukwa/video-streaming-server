const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const BASE = 'https://mettahub.mettaxiot.com/gps/v2/openapi';
const labels = { '00': 'screenshot', '01': 'audio', '02': 'video', '03': 'text', '04': 'other' };

async function main() {
  const tokenRes = await axios.post(`${BASE}/system/createToken`, {
    apiKey: process.env.VIDEO_API_KEY,
    apiSecret: process.env.VIDEO_API_SECRET
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  const token = tokenRes.data.data;
  console.log('=== Testing /alarm/file/id per alert ===\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const alerts = await pool.query(`
    SELECT DISTINCT ON (alarm_type) id, alarm_type, alarm_ts, device_id, device_name
    FROM alerts ORDER BY alarm_type, alarm_ts DESC LIMIT 15
  `);

  let epsTotal = 0, epsWithFiles = 0;

  for (const row of alerts.rows) {
    try {
      const res = await axios.post(`${BASE}/alarm/file/id`, { alarmId: row.id }, {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      const files = res.data.data || [];
      epsTotal += files.length;
      if (files.length > 0) epsWithFiles++;

      const t = {};
      files.forEach(f => { t[f.fileType] = (t[f.fileType] || 0) + 1; });
      const summary = Object.entries(t).map(([k, v]) => `${v}x ${labels[k] || k}`).join(', ') || 'none';

      const type = (row.alarm_type || '?').padEnd(26);
      const dev = ((row.device_name || '') + '').substring(0, 16).padEnd(16);
      console.log(`id=${row.id.slice(-8)} type=${type} device=${dev} files=${String(files.length).padStart(2)} [${summary}]`);
      files.forEach((f, i) => {
        const ft = labels[f.fileType] || f.fileType;
        console.log(`  [${i + 1}] ${ft}  ${(f.fileSize || 0) + 'MB'.padEnd(6)} ${(f.fileUrl || '').slice(0, 85)}`);
      });
    } catch(e) {
      const type = (row.alarm_type || '?').padEnd(26);
      console.log(`id=${row.id.slice(-8)} type=${type} ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`\n=== EPS results: ${alerts.rows.length} alerts, ${epsWithFiles} with files, ${epsTotal} total files ===`);

  // Now compare with DB state
  const counts = await Promise.all([
    pool.query('SELECT COUNT(*) FROM alerts'),
    pool.query("SELECT COUNT(*) FROM alert_media WHERE file_type = '00'"),
    pool.query("SELECT COUNT(*) FROM alert_media WHERE file_type = '02'"),
    pool.query('SELECT COUNT(*) FROM alerts a LEFT JOIN alert_media m ON m.alert_id = a.id WHERE m.id IS NULL'),
    pool.query("SELECT m.alert_id, COUNT(*) as cnt, COUNT(*) FILTER (WHERE m.file_type = '00') as ss, COUNT(*) FILTER (WHERE m.file_type = '02') as vids FROM alert_media m GROUP BY m.alert_id ORDER BY cnt DESC LIMIT 5"),
  ]);

  console.log(`\n=== DB state ===`);
  console.log(`Total alerts: ${counts[0].rows[0].count}`);
  console.log(`Screenshots (type 00): ${counts[1].rows[0].count}`);
  console.log(`Videos (type 02): ${counts[2].rows[0].count}`);
  console.log(`Alerts with no media: ${counts[3].rows[0].count}`);
  console.log(`\nTop alerts by media count:`);
  counts[4].rows.forEach(r => console.log(`  alert=${r.alert_id.slice(-6)} total=${r.cnt} screenshots=${r.ss} videos=${r.vids}`));

  pool.end();
}
main().catch(console.error);
