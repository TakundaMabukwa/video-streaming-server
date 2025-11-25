const axios = require('axios');

async function checkDeviceData() {
  try {
    console.log('🔍 Analyzing device data structure...\n');

    // Get full device data
    const devices = await axios.post('http://localhost:3000/api/stream/devices', {
      pageIndex: 1
    });

    console.log('📱 Sample Device Data Structure:');
    const sampleDevice = devices.data.data.records[0];
    console.log(JSON.stringify(sampleDevice, null, 2));

    console.log('\n🏷️ Device Name Analysis:');
    devices.data.data.records.slice(0, 5).forEach((device, index) => {
      console.log(`${index + 1}. Name: "${device.deviceName}" | ID: ${device.id} | Type: ${device.deviceType}`);
    });

    console.log('\n🔍 Looking for license plate fields...');
    const deviceFields = Object.keys(sampleDevice);
    console.log('Available fields:', deviceFields);
    
    const plateFields = deviceFields.filter(field => 
      field.toLowerCase().includes('plate') || 
      field.toLowerCase().includes('license') ||
      field.toLowerCase().includes('number') ||
      field.toLowerCase().includes('vehicle')
    );
    
    if (plateFields.length > 0) {
      console.log('✅ Potential plate fields found:', plateFields);
    } else {
      console.log('❌ No obvious license plate fields found');
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

checkDeviceData();