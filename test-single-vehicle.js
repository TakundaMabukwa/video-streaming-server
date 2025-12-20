const axios = require('axios');

async function testSingleVehicle() {
  console.log('Testing single vehicle with all channels...\n');

  try {
    // Get all vehicles but filter to just JL65CPGP
    const response = await axios.post('http://localhost:3000/api/stream/vehicles/streams', {
      allChannels: true,
      onlineOnly: false,
      timeout: 15000,
      includeOffline: true
    }, { timeout: 180000 });

    const vehicles = response.data.data.vehicles;
    const jl65 = vehicles.find(v => v.plateName === 'JL65CPGP');
    
    if (jl65) {
      console.log(`✅ Vehicle: ${jl65.plateName}`);
      console.log(`   Device ID: ${jl65.deviceId}`);
      console.log(`   Total Cameras: ${jl65.cameras}`);
      console.log(`   Available Channels: ${jl65.availableChannels}`);
      console.log(`   Channels Retrieved: ${jl65.channels.length}\n`);

      if (jl65.channels.length > 0) {
        console.log('Streams:');
        jl65.channels.forEach(ch => {
          console.log(`   Camera ${ch.channelId}: ✅`);
        });
      } else {
        console.log('❌ No channels retrieved');
      }
    } else {
      console.log('❌ JL65CPGP not found in response');
      console.log(`Total vehicles: ${vehicles.length}`);
    }

  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

testSingleVehicle();
