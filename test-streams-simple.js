const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/stream';

async function testStreams() {
  console.log('🔍 Testing Live Streams...\n');

  try {
    // 1. Get all devices from network
    console.log('1. Getting network devices...');
    const networkResponse = await axios.get(`${BASE_URL}/network`);
    
    if (networkResponse.data.success) {
      const devices = networkResponse.data.data.devices;
      console.log(`✅ Found ${devices.length} total devices\n`);
      
      if (devices.length === 0) {
        console.log('❌ No devices found');
        return;
      }

      // 2. Test live streams for first 3 devices
      console.log('2. Testing live streams...');
      const testDevices = devices.slice(0, 3);
      
      for (const device of testDevices) {
        console.log(`\n📹 Testing stream for: ${device.plateName} (${device.cameras} cameras)`);
        
        try {
          const streamResponse = await axios.post(`${BASE_URL}/live`, {
            deviceId: device.deviceId,
            channelId: 1,
            bitstreamType: 1
          });
          
          if (streamResponse.data.success) {
            const streamUrl = streamResponse.data.data.streamUrl;
            console.log(`✅ Stream URL obtained: ${streamUrl.substring(0, 80)}...`);
          } else {
            console.log(`❌ Failed to get stream: ${streamResponse.data.message}`);
          }
        } catch (error) {
          console.log(`❌ Error: ${error.response?.data?.message || error.message}`);
        }
      }
      
      // 3. Test vehicles with streams endpoint
      console.log('\n3. Testing vehicles with streams (online only)...');
      
      try {
        const vehiclesResponse = await axios.post(`${BASE_URL}/vehicles/streams`, {
          onlineOnly: true,
          limit: 5,
          timeout: 3000
        });
        
        if (vehiclesResponse.data.success) {
          const vehicles = vehiclesResponse.data.data.vehicles;
          console.log(`✅ Found ${vehicles.length} vehicles with active streams`);
          
          vehicles.forEach(vehicle => {
            if (vehicle.streamUrl) {
              console.log(`   📺 ${vehicle.plateName}: Stream available`);
            }
          });
        } else {
          console.log(`❌ Failed: ${vehiclesResponse.data.message}`);
        }
      } catch (error) {
        console.log(`❌ Error: ${error.response?.data?.message || error.message}`);
      }
      
    } else {
      console.log('❌ Failed to get devices:', networkResponse.data.message);
    }
    
  } catch (error) {
    console.log('❌ Test failed:', error.message);
  }
}

testStreams();