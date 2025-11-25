const axios = require('axios');

async function testPlateSearch() {
  try {
    console.log('🔍 Testing plate/device name search...\n');

    // Test 1: Get device by name
    console.log('1. Testing device search by name...');
    const deviceResponse = await axios.post('http://localhost:3000/api/stream/device/name', {
      deviceName: 'JY54WJGP'
    });
    console.log('✅ Device found:', deviceResponse.data.data.deviceName);
    console.log('   ID:', deviceResponse.data.data.id);
    console.log('   Cameras:', deviceResponse.data.data.camCount);

    // Test 2: Get stream directly by plate
    console.log('\n2. Testing stream by plate...');
    const streamResponse = await axios.post('http://localhost:3000/api/stream/live/plate', {
      plateName: 'JY54WJGP',
      channelId: 1,
      bitstreamType: 1
    });
    console.log('✅ Stream by plate:', streamResponse.data.data.plateName);
    console.log('   Stream URL:', streamResponse.data.data.streamUrl);

    // Test 3: Try multiple plates
    console.log('\n3. Testing multiple plates...');
    const plates = ['MK88LTGP', 'MK88MLGP', 'JR30SZGP'];
    
    for (const plate of plates) {
      try {
        const response = await axios.post('http://localhost:3000/api/stream/live/plate', {
          plateName: plate,
          channelId: 1
        });
        console.log(`✅ ${plate}: ${response.data.data.streamUrl ? 'Online' : 'Offline'}`);
      } catch (error) {
        console.log(`❌ ${plate}: ${error.response?.data?.message || 'Error'}`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testPlateSearch();