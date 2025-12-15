const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/stream';

async function testLiveStreams() {
  console.log('🔍 Testing Live Online Streams...\n');

  try {
    // 1. Get online devices first
    console.log('1. Getting online devices...');
    const onlineResponse = await axios.post(`${BASE_URL}/online`, {});
    
    if (onlineResponse.data.success) {
      const onlineDevices = onlineResponse.data.data.devices;
      console.log(`✅ Found ${onlineDevices.length} online devices\n`);
      
      if (onlineDevices.length === 0) {
        console.log('❌ No online devices found');
        return;
      }

      // 2. Test live streams for first 5 online devices
      console.log('2. Testing live streams for online devices...');
      const testDevices = onlineDevices.slice(0, 5);
      
      for (const device of testDevices) {
        console.log(`\n📹 Testing stream for: ${device.plateName}`);
        
        try {
          const streamResponse = await axios.post(`${BASE_URL}/live`, {
            deviceId: device.deviceId,
            channelId: 1,
            bitstreamType: 1
          });
          
          if (streamResponse.data.success) {
            const streamUrl = streamResponse.data.data.streamUrl;
            console.log(`✅ Stream URL: ${streamUrl}`);
            
            // Test if stream is actually accessible
            try {
              const testStream = await axios.head(streamUrl, { timeout: 5000 });
              console.log(`✅ Stream is accessible (${testStream.status})`);
            } catch (streamError) {
              console.log(`⚠️  Stream URL generated but not accessible: ${streamError.message}`);
            }
          } else {
            console.log(`❌ Failed to get stream: ${streamResponse.data.message}`);
          }
        } catch (error) {
          console.log(`❌ Error getting stream: ${error.message}`);
        }
      }
      
      // 3. Test stream by plate name
      console.log('\n3. Testing stream by plate name...');
      const firstDevice = onlineDevices[0];
      
      try {
        const plateResponse = await axios.post(`${BASE_URL}/live/plate`, {
          plateName: firstDevice.plateName,
          channelId: 1,
          bitstreamType: 1
        });
        
        if (plateResponse.data.success) {
          console.log(`✅ Stream by plate successful for: ${firstDevice.plateName}`);
          console.log(`   Stream URL: ${plateResponse.data.data.streamUrl}`);
        } else {
          console.log(`❌ Stream by plate failed: ${plateResponse.data.message}`);
        }
      } catch (error) {
        console.log(`❌ Error getting stream by plate: ${error.message}`);
      }
      
    } else {
      console.log('❌ Failed to get online devices:', onlineResponse.data.message);
    }
    
  } catch (error) {
    console.log('❌ Test failed:', error.message);
  }
}

// Run the test
testLiveStreams();