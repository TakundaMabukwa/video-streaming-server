const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/stream';

async function getAllLiveStreams() {
  console.log('🎥 Getting All Live Streams...\n');

  try {
    // Get all vehicles with streams
    console.log('Scanning all devices for live streams...');
    
    const response = await axios.post(`${BASE_URL}/vehicles/streams`, {
      onlineOnly: true,
      timeout: 5000
    });
    
    if (response.data.success) {
      const vehicles = response.data.data.vehicles;
      console.log(`\n✅ Found ${vehicles.length} vehicles with active streams:\n`);
      
      vehicles.forEach((vehicle, index) => {
        console.log(`${index + 1}. ${vehicle.plateName}`);
        console.log(`   📺 Stream: ${vehicle.streamUrl}`);
        console.log(`   📹 Cameras: ${vehicle.cameras}`);
        console.log(`   🏢 Customer: ${vehicle.customerName}`);
        console.log('');
      });
      
      // Test stream accessibility for first stream
      if (vehicles.length > 0) {
        console.log('Testing stream accessibility...');
        const firstStream = vehicles[0];
        
        try {
          const streamTest = await axios.head(firstStream.streamUrl, { 
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
          console.log(`✅ Stream ${firstStream.plateName} is accessible (${streamTest.status})`);
        } catch (error) {
          console.log(`⚠️  Stream ${firstStream.plateName} URL generated but may need authentication`);
        }
      }
      
    } else {
      console.log('❌ Failed to get streams:', response.data.message);
    }
    
  } catch (error) {
    console.log('❌ Error:', error.response?.data?.message || error.message);
  }
}

getAllLiveStreams();