const axios = require('axios');

async function listAllPlates() {
  try {
    console.log('📋 All available plates in your system:\n');

    const response = await axios.post('http://localhost:3000/api/stream/devices', {
      pageIndex: 1
    });

    if (response.data.success) {
      const devices = response.data.data.records;
      console.log(`Total devices: ${devices.length}\n`);
      
      devices.forEach((device, index) => {
        console.log(`${index + 1}. ${device.deviceName} (ID: ${device.id})`);
      });

      console.log('\n🔍 Searching for plates containing "KD"...');
      const kdPlates = devices.filter(d => d.deviceName.includes('KD'));
      if (kdPlates.length > 0) {
        kdPlates.forEach(device => {
          console.log(`✅ Found: ${device.deviceName} (ID: ${device.id})`);
        });
      } else {
        console.log('❌ No plates containing "KD" found');
      }

      console.log('\n📝 Available plates you can test:');
      devices.slice(0, 10).forEach(device => {
        console.log(`   ${device.deviceName}`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

listAllPlates();