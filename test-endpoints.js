const axios = require('axios');

const baseURL = 'http://localhost:3000/api';

async function testEndpoints() {
  console.log('Testing Video Feed Server Endpoints...\n');

  try {
    // Test 1: Health Check
    console.log('1. Testing Health Check...');
    const health = await axios.get(`${baseURL}/health`);
    console.log('✅ Health:', health.data.message);

    // Test 2: Get Customer Tree
    console.log('\n2. Testing Customer Tree...');
    const customers = await axios.post(`${baseURL}/stream/customers`, {});
    console.log('✅ Customers:', customers.data.message);
    console.log('   Data count:', customers.data.data?.length || 0);

    // Test 3: Get Devices
    console.log('\n3. Testing Get Devices...');
    const devices = await axios.post(`${baseURL}/stream/devices`, {
      pageIndex: 1
    });
    console.log('✅ Devices:', devices.data.message);
    console.log('   Total devices:', devices.data.data?.total || 0);

    // Test 4: Get Live Stream (if devices exist)
    if (devices.data.data?.records?.length > 0) {
      const deviceId = devices.data.data.records[0].id;
      console.log('\n4. Testing Live Stream...');
      const stream = await axios.post(`${baseURL}/stream/live`, {
        deviceId: deviceId,
        channelId: 1,
        bitstreamType: 1
      });
      console.log('✅ Live Stream:', stream.data.message);
      console.log('   Stream URL:', stream.data.data?.streamUrl ? 'Generated' : 'None');
    } else {
      console.log('\n4. Skipping Live Stream test (no devices found)');
    }

    console.log('\n🎉 All tests completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testEndpoints();