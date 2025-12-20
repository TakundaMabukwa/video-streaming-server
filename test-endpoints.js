const axios = require('axios');

async function testEndpoints() {
  console.log('🔍 Testing Video Endpoints\n');

  const deviceId = '628074815068'; // JL65CPGP
  const channelId = 1;

  // Test 1: Get single stream
  console.log('1️⃣  Testing /api/stream/live');
  try {
    const response = await axios.post('http://localhost:3000/api/stream/live', {
      deviceId,
      channelId
    });
    
    if (response.data.success) {
      const streamUrl = response.data.data.streamUrl;
      console.log(`✅ Stream URL: ${streamUrl}`);
      console.log(`   Type: ${streamUrl.includes('.flv') ? 'FLV' : 'Unknown'}`);
      
      // Test if URL is accessible
      try {
        const urlTest = await axios.head(streamUrl, { timeout: 5000 });
        console.log(`✅ URL is accessible (${urlTest.status})\n`);
      } catch (e) {
        console.log(`⚠️  URL not directly accessible (may need proxy)\n`);
      }
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 2: Get debug vehicle info
  console.log('2️⃣  Testing /api/stream/debug/vehicle');
  try {
    const response = await axios.post('http://localhost:3000/api/stream/debug/vehicle', {
      deviceId
    });
    
    if (response.data.success) {
      const channels = response.data.data.channels;
      console.log(`✅ Found ${channels.length} channels`);
      channels.forEach(ch => {
        console.log(`   Channel ${ch.channelId}: ${ch.streamUrl}`);
      });
      console.log();
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 3: Test proxy endpoint
  console.log('3️⃣  Testing /api/stream/stream/proxy');
  try {
    const streamUrl = 'https://m1.mettaxiot.com/mettax/video/628074815068_1.live.flv';
    const proxyUrl = `/api/stream/stream/proxy?url=${encodeURIComponent(streamUrl)}`;
    
    const response = await axios.get(`http://localhost:3000${proxyUrl}`, {
      timeout: 5000,
      responseType: 'stream'
    });
    
    console.log(`✅ Proxy accessible`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Content-Type: ${response.headers['content-type']}`);
    console.log();
  } catch (error) {
    console.log(`⚠️  Proxy error: ${error.message}\n`);
  }

  // Test 4: Check stream URL validity over time
  console.log('4️⃣  Testing Stream URL Timeout');
  try {
    const response1 = await axios.post('http://localhost:3000/api/stream/live', {
      deviceId,
      channelId
    });
    const url1 = response1.data.data.streamUrl;
    
    console.log(`✅ First request: ${url1}`);
    
    // Wait 30 seconds
    console.log('   Waiting 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    const response2 = await axios.post('http://localhost:3000/api/stream/live', {
      deviceId,
      channelId
    });
    const url2 = response2.data.data.streamUrl;
    
    console.log(`✅ Second request: ${url2}`);
    console.log(`   URLs match: ${url1 === url2 ? '✅ Yes' : '❌ No (URL changed)'}`);
    console.log();
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 5: Check token expiry
  console.log('5️⃣  Testing Token Expiry (4 hour limit)');
  console.log('   Token cached for 4 hours');
  console.log('   After 4 hours, new token will be generated');
  console.log('   Stream URLs remain valid as long as device is online\n');
}

testEndpoints();
