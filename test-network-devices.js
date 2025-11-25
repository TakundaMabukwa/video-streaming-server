const axios = require('axios');

async function getAllNetworkDevices() {
  try {
    console.log('🌐 Getting all devices under this network...\n');

    const response = await axios.get('http://localhost:3000/api/stream/network');

    if (response.data.success) {
      const network = response.data.data;
      
      console.log('📊 NETWORK OVERVIEW:');
      console.log(`Customer: ${network.customer?.customerName || 'N/A'}`);
      console.log(`Total Devices: ${network.totalDevices}`);
      console.log(`Total Cameras: ${network.totalCameras}`);
      console.log(`Device Types: ${network.deviceTypes.join(', ')}`);
      
      console.log('\n📱 ALL DEVICES:');
      network.devices.forEach((device, index) => {
        console.log(`${index + 1}. ${device.plateName}`);
        console.log(`   Device ID: ${device.deviceId}`);
        console.log(`   Type: ${device.deviceType}`);
        console.log(`   Cameras: ${device.cameras}`);
        console.log(`   Customer: ${device.customerName}`);
        console.log(`   Active: ${device.activeTime}`);
        console.log(`   Expires: ${device.expirationTime}`);
        console.log(`   Timezone: ${device.timezone}`);
        console.log('');
      });

      console.log('📋 PLATE SUMMARY:');
      network.devices.forEach(device => {
        console.log(`   ${device.plateName} (${device.cameras} cameras)`);
      });

    } else {
      console.error('❌ Failed:', response.data.message);
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

getAllNetworkDevices();