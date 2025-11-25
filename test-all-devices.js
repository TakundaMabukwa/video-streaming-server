const axios = require('axios');

async function testAllDevices() {
  try {
    console.log('🔍 Testing all devices for live streaming...\n');

    // Get all devices
    const devices = await axios.post('http://localhost:3000/api/stream/devices', {
      pageIndex: 1
    });

    const deviceList = devices.data.data.records;
    console.log(`Found ${deviceList.length} devices. Testing each for live streaming...\n`);

    let onlineCount = 0;
    let streamCount = 0;

    for (let i = 0; i < deviceList.length; i++) {
      const device = deviceList[i];
      console.log(`${i + 1}. Testing ${device.deviceName} (${device.id})`);
      
      try {
        // Test live stream
        const stream = await axios.post('http://localhost:3000/api/stream/live', {
          deviceId: device.id,
          channelId: 1,
          bitstreamType: 1
        });
        
        console.log(`   ✅ ONLINE - Stream URL generated!`);
        console.log(`   📺 URL: ${stream.data.data.streamUrl}`);
        onlineCount++;
        streamCount++;
        
      } catch (error) {
        const message = error.response?.data?.message || 'Unknown error';
        if (message === 'device offline') {
          console.log(`   🔴 OFFLINE`);
        } else {
          console.log(`   ❌ ERROR: ${message}`);
          onlineCount++; // Device might be online but have other issues
        }
      }
      
      // Small delay to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Total devices: ${deviceList.length}`);
    console.log(`   Online devices: ${onlineCount}`);
    console.log(`   Streaming devices: ${streamCount}`);
    
    if (streamCount > 0) {
      console.log(`\n🎉 Found ${streamCount} device(s) ready for live streaming!`);
    } else {
      console.log(`\n⚠️  No devices currently online for streaming.`);
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testAllDevices();