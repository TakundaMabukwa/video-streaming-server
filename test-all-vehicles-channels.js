const axios = require('axios');

async function testAllVehiclesChannels() {
  console.log('Testing all vehicles with all channels...\n');

  try {
    // Get all vehicles
    const vehiclesResponse = await axios.get('http://localhost:3000/api/stream/network');
    const vehicles = vehiclesResponse.data.data.devices;
    
    console.log(`Found ${vehicles.length} vehicles\n`);

    let totalRequests = 0;
    let successCount = 0;
    let rateLimitCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    for (const vehicle of vehicles) {
      console.log(`\n🚗 ${vehicle.plateName} (${vehicle.cameras} cameras)`);
      
      for (let channelId = 1; channelId <= vehicle.cameras; channelId++) {
        totalRequests++;
        
        try {
          const response = await axios.post('http://localhost:3000/api/stream/live', {
            deviceId: vehicle.deviceId,
            channelId
          });

          if (response.data.success) {
            successCount++;
            process.stdout.write('✅');
          } else {
            process.stdout.write('⚠️ ');
          }
        } catch (error) {
          const msg = error.response?.data?.message || error.message;
          if (msg.includes('rate limit') || msg.includes('call count')) {
            rateLimitCount++;
            process.stdout.write('🚫');
          } else {
            errorCount++;
            process.stdout.write('❌');
          }
        }
      }
    }

    const duration = Date.now() - startTime;

    console.log(`\n\n📊 Final Results:`);
    console.log(`   Total Requests: ${totalRequests}`);
    console.log(`   ✅ Success: ${successCount}/${totalRequests}`);
    console.log(`   🚫 Rate Limited: ${rateLimitCount}/${totalRequests}`);
    console.log(`   ❌ Errors: ${errorCount}/${totalRequests}`);
    console.log(`   ⏱️  Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`   📈 Rate: ${(totalRequests / (duration / 1000)).toFixed(1)} req/s`);

  } catch (error) {
    console.log('Error:', error.message);
  }
}

testAllVehiclesChannels();
