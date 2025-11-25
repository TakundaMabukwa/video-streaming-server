const apiClient = require('./src/helpers/apiClient');

async function debugRawApi() {
  try {
    console.log('🔍 Testing raw MettaHub API response...\n');

    // Make direct API call to MettaHub
    const rawResponse = await apiClient.makeRequest('/video/live', {
      deviceId: '353076706570',
      channelId: 1,
      bitstreamType: 1
    });

    console.log('📡 Raw MettaHub API Response:');
    console.log(JSON.stringify(rawResponse, null, 2));

    console.log('\n🔗 Stream URL Analysis:');
    console.log('MettaHub returns:', rawResponse.data);
    console.log('URL Type:', typeof rawResponse.data);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

debugRawApi();