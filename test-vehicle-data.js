const apiClient = require('./src/helpers/apiClient');

async function testVehicleEndpoints() {
  try {
    console.log('🔍 Testing for vehicle/license plate data...\n');

    const deviceId = '353076706570'; // Online device

    // Test various potential endpoints
    const endpoints = [
      '/device/info',
      '/vehicle/info', 
      '/device/detail',
      '/device/expand',
      '/device/vehicle',
      '/vehicle/plate',
      '/device/license'
    ];

    for (const endpoint of endpoints) {
      try {
        console.log(`Testing: ${endpoint}`);
        const response = await apiClient.makeRequest(endpoint, { deviceId });
        
        if (response.code === 0) {
          console.log(`✅ ${endpoint} - Success!`);
          console.log('Data:', JSON.stringify(response.data, null, 2));
          
          // Look for plate-related fields
          const dataStr = JSON.stringify(response.data).toLowerCase();
          if (dataStr.includes('plate') || dataStr.includes('license') || dataStr.includes('vehicle')) {
            console.log('🎯 Potential license plate data found!');
          }
        } else {
          console.log(`❌ ${endpoint} - ${response.msg || 'Failed'}`);
        }
      } catch (error) {
        console.log(`❌ ${endpoint} - ${error.message}`);
      }
      console.log('');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testVehicleEndpoints();