const axios = require('axios');

async function checkOnlineDevices() {
  try {
    // Get customer ID first
    const customers = await axios.post('http://localhost:3000/api/stream/customers', {});
    const customerId = customers.data.data[0]?.id;
    
    if (!customerId) {
      console.log('❌ No customer ID found');
      return;
    }

    console.log(`🔍 Checking device status for customer: ${customerId}\n`);

    // Get device shadow data (real-time status)
    const response = await axios.post('http://localhost:3000/api/stream/shadow', {
      customerId: customerId
    });

    console.log('📡 Device Shadow Data (Real-time Status):');
    
    if (response.data.data && response.data.data.length > 0) {
      response.data.data.forEach((device, index) => {
        const deviceData = device.deviceData;
        const expand = device.expand;
        
        console.log(`\n${index + 1}. Device: ${deviceData.deviceName}`);
        console.log(`   ID: ${deviceData.deviceId}`);
        console.log(`   Status: ${expand.status ? '🟢 ONLINE' : '🔴 OFFLINE'}`);
        console.log(`   Last Report: ${expand.reportTime}`);
        console.log(`   Active Time: ${expand.activeTime}`);
        console.log(`   Location: ${deviceData.address}`);
        console.log(`   Speed: ${deviceData.speed} km/h`);
        console.log(`   Battery: ${deviceData.voltage}V`);
        
        // Try live stream if online
        if (expand.status) {
          console.log(`   🎥 Attempting live stream...`);
          testLiveStream(deviceData.deviceId);
        }
      });
    } else {
      console.log('No device shadow data available');
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

async function testLiveStream(deviceId) {
  try {
    const stream = await axios.post('http://localhost:3000/api/stream/live', {
      deviceId: deviceId,
      channelId: 1,
      bitstreamType: 1
    });
    console.log(`   ✅ Stream URL: ${stream.data.data.streamUrl}`);
  } catch (error) {
    console.log(`   ❌ Stream failed: ${error.response?.data?.message || error.message}`);
  }
}

checkOnlineDevices();