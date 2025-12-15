const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/stream';

async function testIndividualStreams() {
  console.log('🔍 Testing Individual Device Streams...\n');

  try {
    // Get all devices
    const networkResponse = await axios.get(`${BASE_URL}/network`);
    
    if (networkResponse.data.success) {
      const devices = networkResponse.data.data.devices;
      console.log(`Testing streams for ${devices.length} devices...\n`);
      
      const liveStreams = [];
      
      // Test each device
      for (let i = 0; i < Math.min(devices.length, 10); i++) {
        const device = devices[i];
        process.stdout.write(`Testing ${device.plateName}... `);
        
        try {
          const streamResponse = await axios.post(`${BASE_URL}/live`, {
            deviceId: device.deviceId,
            channelId: 1,
            bitstreamType: 1
          }, { timeout: 8000 });
          
          if (streamResponse.data.success) {
            console.log('✅ LIVE');
            liveStreams.push({
              plateName: device.plateName,
              deviceId: device.deviceId,
              streamUrl: streamResponse.data.data.streamUrl,
              cameras: device.cameras
            });
          } else {
            console.log('❌ OFFLINE');
          }
        } catch (error) {
          const msg = error.response?.data?.message || error.message;
          if (msg.includes('offline')) {
            console.log('❌ OFFLINE');
          } else if (msg.includes('rate limit')) {
            console.log('⏳ RATE LIMITED');
            break;
          } else {
            console.log(`❌ ERROR: ${msg}`);
          }
        }
      }
      
      console.log(`\n🎥 LIVE STREAMS FOUND: ${liveStreams.length}\n`);
      
      liveStreams.forEach((stream, index) => {
        console.log(`${index + 1}. ${stream.plateName}`);
        console.log(`   📺 ${stream.streamUrl}`);
        console.log(`   📹 ${stream.cameras} cameras\n`);
      });
      
    } else {
      console.log('❌ Failed to get devices');
    }
    
  } catch (error) {
    console.log('❌ Test failed:', error.message);
  }
}

testIndividualStreams();