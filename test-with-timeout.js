const axios = require('axios');

async function testWithTimeout() {
  console.log('Testing vehicles/streams with 10s timeout...\n');

  try {
    const response = await axios.post('http://localhost:3000/api/stream/vehicles/streams', {
      allChannels: true,
      onlineOnly: false,
      timeout: 10000,
      includeOffline: true
    }, { timeout: 120000 });

    const data = response.data.data;
    console.log(`Total Vehicles: ${data.totalVehicles}\n`);

    // Find JL65CPGP
    const jl65 = data.vehicles.find(v => v.plateName === 'JL65CPGP');
    
    if (jl65) {
      console.log(`Vehicle: ${jl65.plateName}`);
      console.log(`Device ID: ${jl65.deviceId}`);
      console.log(`Cameras: ${jl65.cameras}`);
      console.log(`Available Channels: ${jl65.availableChannels}`);
      console.log(`Channels: ${jl65.channels.length}\n`);

      jl65.channels.forEach(ch => {
        console.log(`  Camera ${ch.channelId}: ${ch.streamUrl}`);
      });
    } else {
      console.log('JL65CPGP not found');
    }

  } catch (error) {
    console.log('Error:', error.message);
  }
}

testWithTimeout();
