const axios = require('axios');
const config = require('./src/config/config');

const SINGAPORE = 'https://mettahub.mettaxiot.com/gps/v2/openapi';
const INDIA = 'https://india.mettaxiot.com/gps/v2/openapi';

async function getToken(baseURL) {
  const res = await axios.post(`${baseURL}/system/createToken`, {
    apiKey: config.videoApiKey,
    apiSecret: config.videoApiSecret
  }, { headers: { 'Content-Type': 'application/json' } });
  if (res.data.code === 0) return res.data.data;
  throw new Error(res.data.msg);
}

async function test() {
  const tokenSg = await getToken(SINGAPORE);
  const tokenIn = await getToken(INDIA);
  
  // Try a few known alert IDs from our DB
  const alertIds = [
    '18765432100',
    '18765432099',
    '18765432098',
  ];
  
  // Also try alarmFile/id with these
  console.log('=== SINGAPORE /alarm/file/id ===');
  for (const id of alertIds.slice(0, 2)) {
    try {
      const res = await axios.post(`${SINGAPORE}/alarm/file/id`, { alarmId: id }, {
        headers: { Authorization: tokenSg, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`ID ${id}: code=${res.data.code}, files=${res.data.data?.length || 0}`);
      if (res.data.data?.length > 0) console.log('  sample:', JSON.stringify(res.data.data[0]).slice(0, 200));
    } catch(e) { console.log(`ID ${id}: ERROR ${e.message}`); }
  }
  
  console.log('\n=== INDIA /alarm/file/id ===');
  for (const id of alertIds.slice(0, 2)) {
    try {
      const res = await axios.post(`${INDIA}/alarm/file/id`, { alarmId: id }, {
        headers: { Authorization: tokenIn, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`ID ${id}: code=${res.data.code}, files=${res.data.data?.length || 0}`);
      if (res.data.data?.length > 0) console.log('  sample:', JSON.stringify(res.data.data[0]).slice(0, 200));
    } catch(e) { console.log(`ID ${id}: ERROR ${e.message}`); }
  }
  
  // Now try alarmFile/page with India
  console.log('\n=== INDIA /alarm/file/page (last 1 hour) ===');
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const start = oneHourAgo.toISOString().replace('T', ' ').slice(0, 19);
  const end = now.toISOString().replace('T', ' ').slice(0, 19);
  
  try {
    const res = await axios.post(`${INDIA}/alarm/file/page`, {
      pageSize: 10, pageIndex: 1, startTime: start, endTime: end,
    }, {
      headers: { Authorization: tokenIn, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    console.log(`code=${res.data.code}, records=${res.data.data?.records?.length || 0}, total=${res.data.data?.total || 0}`);
    if (res.data.data?.records?.length > 0) {
      console.log('  sample:', JSON.stringify(res.data.data.records[0]).slice(0, 300));
    }
  } catch(e) { console.log(`ERROR: ${e.message}`); }
}

test().catch(console.error);
