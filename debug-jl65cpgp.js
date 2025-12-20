const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/stream';

async function debugVehicle() {
  console.log('🔍 Debugging JL65CPGP (628074815068)...\n');

  try {
    // Test debug endpoint
    const response = await axios.post(`${BASE_URL}/debug/vehicle`, {
      deviceId: '628074815068'
    });

    if (response.data.success) {
      const result = response.data.data;
      console.log(`Vehicle: ${result.device.plateName}`);
      console.log(`Device ID: ${result.device.deviceId}`);
      console.log(`Total Cameras: ${result.device.cameras}`);
      console.log(`Successful Channels: ${result.successCount}\n`);

      console.log('Channel Details:');
      result.channels.forEach(channel => {
        if (channel.success) {
          console.log(`✅ Channel ${channel.channelId}: ${channel.streamUrl}`);
        } else {
          console.log(`❌ Channel ${channel.channelId}: ${channel.message || channel.error}`);
        }
      });
    } else {
      console.log('Error:', response.data.message);
    }
  } catch (error) {
    console.log('Request failed:', error.message);
  }
}

debugVehicle();
