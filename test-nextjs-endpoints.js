const axios = require('axios');

const BASE_URL = 'http://161.35.25.105:3000/api/stream';

async function testAllEndpoints() {
  console.log('🧪 Testing All Video Endpoints for Next.js\n');
  console.log('Base URL:', BASE_URL, '\n');

  // Test 1: Get all vehicles
  console.log('1️⃣  GET /network - Get all vehicles');
  try {
    const response = await axios.get(`${BASE_URL}/network`);
    if (response.data.success) {
      console.log(`✅ Success: ${response.data.data.totalDevices} vehicles found`);
      console.log(`   Sample: ${response.data.data.devices[0].plateName}\n`);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 2: Get single vehicle stream
  console.log('2️⃣  POST /live - Get single stream');
  try {
    const response = await axios.post(`${BASE_URL}/live`, {
      deviceId: '628074815068',
      channelId: 1
    });
    if (response.data.success) {
      const url = response.data.data.streamUrl;
      console.log(`✅ Success: Stream URL obtained`);
      console.log(`   URL: ${url.substring(0, 80)}...\n`);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 3: Get vehicle by plate
  console.log('3️⃣  POST /live/plate - Get stream by plate name');
  try {
    const response = await axios.post(`${BASE_URL}/live/plate`, {
      plateName: 'JL65CPGP',
      channelId: 1
    });
    if (response.data.success) {
      console.log(`✅ Success: ${response.data.data.plateName}`);
      console.log(`   Stream: ${response.data.data.streamUrl.substring(0, 80)}...\n`);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 4: Get all vehicles with streams
  console.log('4️⃣  POST /vehicles/streams - Get all vehicles with all channels');
  try {
    const response = await axios.post(`${BASE_URL}/vehicles/streams`, {
      allChannels: true,
      onlineOnly: false,
      timeout: 10000,
      includeOffline: true
    }, { timeout: 120000 });
    
    if (response.data.success) {
      const vehicles = response.data.data.vehicles;
      const withStreams = vehicles.filter(v => v.channels.length > 0);
      console.log(`✅ Success: ${vehicles.length} vehicles, ${withStreams.length} with streams`);
      if (withStreams.length > 0) {
        console.log(`   Sample: ${withStreams[0].plateName} - ${withStreams[0].channels.length} channels\n`);
      }
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 5: Debug single vehicle
  console.log('5️⃣  POST /debug/vehicle - Debug single vehicle channels');
  try {
    const response = await axios.post(`${BASE_URL}/debug/vehicle`, {
      deviceId: '628074815068'
    });
    if (response.data.success) {
      const channels = response.data.data.channels;
      const success = channels.filter(c => c.success).length;
      console.log(`✅ Success: ${success}/${channels.length} channels active`);
      channels.forEach(ch => {
        console.log(`   Channel ${ch.channelId}: ${ch.success ? '✅' : '❌'}`);
      });
      console.log();
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }

  // Test 6: Stream proxy
  console.log('6️⃣  GET /stream/proxy - Proxy stream URL');
  try {
    const streamUrl = 'https://m1.mettaxiot.com/mettax/video/628074815068_1.live.flv';
    const proxyUrl = `${BASE_URL}/stream/proxy?url=${encodeURIComponent(streamUrl)}`;
    
    const response = await axios.get(proxyUrl, {
      timeout: 5000,
      responseType: 'stream'
    });
    
    console.log(`✅ Success: Proxy working`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Content-Type: ${response.headers['content-type']}\n`);
  } catch (error) {
    console.log(`⚠️  Proxy: ${error.message}\n`);
  }

  // Test 7: Stream URL validity
  console.log('7️⃣  Testing Stream URL Validity');
  try {
    const response = await axios.post(`${BASE_URL}/live`, {
      deviceId: '628074815068',
      channelId: 1
    });
    
    if (response.data.success) {
      const url = response.data.data.streamUrl;
      console.log(`✅ URL Format: ${url.includes('.flv') ? 'FLV' : 'Unknown'}`);
      console.log(`   Protocol: ${url.startsWith('https') ? 'HTTPS' : 'HTTP'}`);
      console.log(`   Valid as long as device is online\n`);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

testAllEndpoints();
