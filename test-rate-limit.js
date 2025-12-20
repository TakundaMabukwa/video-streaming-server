const axios = require('axios');

async function testRateLimit() {
  console.log('Testing API rate limiting...\n');

  const deviceId = '628074815068';
  const requests = 20;
  let successCount = 0;
  let rateLimitCount = 0;
  let errorCount = 0;

  for (let i = 1; i <= requests; i++) {
    try {
      const start = Date.now();
      const response = await axios.post('http://localhost:3000/api/stream/live', {
        deviceId,
        channelId: 1
      });
      const duration = Date.now() - start;

      if (response.data.success) {
        successCount++;
        console.log(`✅ Request ${i}: Success (${duration}ms)`);
      } else {
        console.log(`⚠️  Request ${i}: ${response.data.message}`);
        if (response.data.message.includes('rate limit')) {
          rateLimitCount++;
        }
      }
    } catch (error) {
      errorCount++;
      const msg = error.response?.data?.message || error.message;
      if (msg.includes('rate limit') || msg.includes('call count')) {
        rateLimitCount++;
        console.log(`🚫 Request ${i}: Rate Limited`);
      } else {
        console.log(`❌ Request ${i}: ${msg}`);
      }
    }
  }

  console.log(`\n📊 Results:`);
  console.log(`   ✅ Success: ${successCount}/${requests}`);
  console.log(`   🚫 Rate Limited: ${rateLimitCount}/${requests}`);
  console.log(`   ❌ Errors: ${errorCount}/${requests}`);
}

testRateLimit();
