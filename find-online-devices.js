const axios = require('axios');

async function findOnlineDevices() {
  try {
    const devices = await axios.post('http://localhost:3000/api/stream/devices', {
      pageIndex: 1
    });

    console.log('📱 Device Status Report:');
    console.log(`Total devices: ${devices.data.data.total}\n`);

    devices.data.data.records.forEach((device, index) => {
      console.log(`${index + 1}. ${device.deviceName || device.id}`);
      console.log(`   ID: ${device.id}`);
      console.log(`   Type: ${device.deviceType}`);
      console.log(`   Active: ${device.activeTime}`);
      console.log(`   Cameras: ${device.camCount}\n`);
    });

    // Try to get a live stream from the first device with cameras
    const deviceWithCam = devices.data.data.records.find(d => d.camCount > 0);
    if (deviceWithCam) {
      console.log(`🎥 Testing stream for device: ${deviceWithCam.deviceName}`);
      const stream = await axios.post('http://localhost:3000/api/stream/live', {
        deviceId: deviceWithCam.id,
        channelId: 1,
        bitstreamType: 1
      });
      console.log('✅ Stream URL generated:', stream.data.data.streamUrl);
    }

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

findOnlineDevices();