const axios = require('axios');

(async () => {
  const tok = await axios.post('https://mettahub.mettaxiot.com/gps/v2/openapi/system/createToken', {
    apiKey: process.env.VIDEO_API_KEY,
    apiSecret: process.env.VIDEO_API_SECRET,
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
  const token = tok.data.data;
  console.log('Token OK');

  // Use an online device: JHD698FS - EX53 (id from the online list)
  // Let me look up its ID first
  const dev = await axios.post('https://mettahub.mettaxiot.com/gps/v2/openapi/device/page', {
    pageIndex: 1, pageSize: 200, deviceName: 'JHD698FS', subsumption: true,
  }, { headers: { 'Authorization': token, 'Content-Type': 'application/json' }, timeout: 15000 });
  const records = dev.data.data?.records || [];
  const match = records.find(d => String(d.deviceName).toUpperCase().startsWith('JHD698FS'));
  if (!match) { console.log('Device not found'); return; }
  const deviceId = match.id;
  console.log('Device:', match.deviceName, 'id:', deviceId);

  // Try /video/history/upload with a small time range (5 min)
  const now = new Date();
  const end = now.toISOString().replace('T', ' ').slice(0, 19);
  const start = new Date(now.getTime() - 5*60*1000).toISOString().replace('T', ' ').slice(0, 19);

  console.log('\nTriggering /video/history/upload...');
  console.log('Range:', start, '-', end);

  try {
    const upload = await axios.post('https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/upload', {
      deviceId, channelId: 1, startTime: start, endTime: end, fileSize: 0,
    }, { headers: { 'Authorization': token, 'Content-Type': 'application/json' }, timeout: 30000 });
    console.log('Upload response:', JSON.stringify(upload.data));

    if (upload.data.code === 0) {
      const taskId = upload.data.data;
      console.log('Task ID:', taskId);

      // Poll for task status
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const task = await axios.post('https://mettahub.mettaxiot.com/gps/v2/openapi/video/history/upload/task', {
          pageSize: 10, pageIndex: 1, taskId: taskId,
        }, { headers: { 'Authorization': token, 'Content-Type': 'application/json' }, timeout: 15000 });
        const records = task.data.data?.records || [];
        if (records.length > 0) {
          console.log(`Poll ${i+1}: status=${records[0].status} fileUrl=${records[0].fileUrl?.slice(-40) || 'null'}`);
          if (records[0].status === 1) {
            console.log('SUCCESS! File URL:', records[0].fileUrl);
            break;
          }
        } else {
          console.log(`Poll ${i+1}: no records yet`);
        }
      }
    }
  } catch(e) {
    console.error('Error:', e.response?.data || e.message);
  }
})();
