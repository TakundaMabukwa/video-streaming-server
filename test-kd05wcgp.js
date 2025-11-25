const axios = require('axios');

async function testKD05WCGP() {
  try {
    console.log('🔍 Testing plate: KD05WCGP\n');

    // Test 1: Search device by name
    console.log('1. Searching device...');
    const deviceResponse = await axios.post('http://localhost:3000/api/stream/device/name', {
      deviceName: 'KD05WCGP'
    });
    
    if (deviceResponse.data.success) {
      console.log('✅ Device found:', deviceResponse.data.data.deviceName);
      console.log('   ID:', deviceResponse.data.data.id);
      console.log('   Cameras:', deviceResponse.data.data.camCount);
      console.log('   Active:', deviceResponse.data.data.activeTime);
    }

    // Test 2: Get stream by plate
    console.log('\n2. Getting live stream...');
    const streamResponse = await axios.post('http://localhost:3000/api/stream/live/plate', {
      plateName: 'KD05WCGP',
      channelId: 1,
      bitstreamType: 1
    });

    if (streamResponse.data.success) {
      console.log('✅ Stream URL:', streamResponse.data.data.streamUrl);
      console.log('   Plate:', streamResponse.data.data.plateName);
      console.log('   Device ID:', streamResponse.data.data.deviceId);
      console.log('   Cameras:', streamResponse.data.data.camCount);
    }

    // Test 3: Try different channels
    console.log('\n3. Testing all camera channels...');
    for (let channel = 1; channel <= 5; channel++) {
      try {
        const channelResponse = await axios.post('http://localhost:3000/api/stream/live/plate', {
          plateName: 'KD05WCGP',
          channelId: channel,
          bitstreamType: 1
        });
        console.log(`   Camera ${channel}: ${channelResponse.data.data.streamUrl}`);
      } catch (error) {
        console.log(`   Camera ${channel}: Error - ${error.response?.data?.message || 'Failed'}`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testKD05WCGP();