const axios = require('axios');

async function testMultiChannel() {
  console.log('Testing multiple channels for same device...\n');

  const deviceId = '628074815068';
  const channels = 5;
  let successCount = 0;
  let rateLimitCount = 0;

  for (let i = 0; i < 3; i++) {
    console.log(`\n--- Iteration ${i + 1} ---`);
    
    for (let channelId = 1; channelId <= channels; channelId++) {
      try {
        const start = Date.now();
        const response = await axios.post('http://localhost:3000/api/stream/live', {
          deviceId,
          channelId
        });
        const duration = Date.now() - start;

        if (response.data.success) {
          successCount++;
          console.log(`✅ Channel ${channelId}: Success (${duration}ms)`);
        } else {
          console.log(`⚠️  Channel ${channelId}: ${response.data.message}`);
        }
      } catch (error) {
        const msg = error.response?.data?.message || error.message;
        if (msg.includes('rate limit') || msg.includes('call count')) {
          rateLimitCount++;
          console.log(`🚫 Channel ${channelId}: Rate Limited`);
        } else {
          console.log(`❌ Channel ${channelId}: ${msg}`);
        }
      }
    }
  }

  console.log(`\n📊 Results:`);
  console.log(`   ✅ Success: ${successCount}/${channels * 3}`);
  console.log(`   🚫 Rate Limited: ${rateLimitCount}/${channels * 3}`);
}

testMultiChannel();
