const axios = require('axios');

async function debugApiResponse() {
  try {
    console.log('🔍 Testing API response structure...\n');

    // Test with an online device
    const response = await axios.post('http://localhost:3000/api/stream/live', {
      deviceId: '353076706570', // JY54WJGP - known online device
      channelId: 1,
      bitstreamType: 1
    });

    console.log('📡 Full API Response:');
    console.log(JSON.stringify(response.data, null, 2));

    console.log('\n🔗 Stream URL Source:');
    console.log('Our server response:', response.data.data.streamUrl);
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

debugApiResponse();