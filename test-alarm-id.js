const axios = require('axios');
require('dotenv').config();

const SINGAPORE = 'https://mettahub.mettaxiot.com/gps/v2/openapi';
const INDIA = 'https://india.mettaxiot.com/gps/v2/openapi';

// Try both credential sets
const creds = [
  { key: process.env.VIDEO_API_KEY, secret: process.env.VIDEO_API_SECRET, label: 'Singapore creds' },
];

async function getToken(baseURL, apiKey, apiSecret) {
  try {
    const res = await axios.post(`${baseURL}/system/createToken`, {
      apiKey, apiSecret
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    if (res.data.code === 0) return res.data.data;
    console.log(`  Token error: ${res.data.msg || res.data.code}`);
    return null;
  } catch(e) {
    console.log(`  Token error: ${e.message}`);
    return null;
  }
}

async function fetchFiles(baseURL, token, alarmId) {
  try {
    const res = await axios.post(`${baseURL}/alarm/file/id`, { alarmId }, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return res.data;
  } catch(e) {
    return { code: -1, msg: e.message };
  }
}

async function test() {
  const alertIds = [
    '2064008068981161984',  // forwardCollisionWarning
    '2064008058914832384',  // seatBelt
    '2064008072034615296',  // occlusion
    '2064008016038555648',  // occlusion
    '2064007981903216640',  // laneShift
  ];

  // Singapore
  console.log('=== SINGAPORE ===');
  const sgToken = await getToken(SINGAPORE, creds[0].key, creds[0].secret);
  if (sgToken) {
    for (const id of alertIds) {
      const result = await fetchFiles(SINGAPORE, sgToken, id);
      console.log(`ID ${id}: code=${result.code}, files=${result.data?.length || 0}`);
      if (result.data?.length > 0) {
        console.log('  files:', result.data.map(f => ({ type: f.fileType, url: (f.fileUrl || '').slice(0, 80) })));
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // India
  console.log('\n=== INDIA ===');
  const inToken = await getToken(INDIA, creds[0].key, creds[0].secret);
  if (inToken) {
    for (const id of alertIds) {
      const result = await fetchFiles(INDIA, inToken, id);
      console.log(`ID ${id}: code=${result.code}, files=${result.data?.length || 0}`);
      if (result.data?.length > 0) {
        console.log('  files:', result.data.map(f => ({ type: f.fileType, url: (f.fileUrl || '').slice(0, 80) })));
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('\nDone');
}

test().catch(console.error);
