const axios = require('axios');

async function debugOnline() {
  try {
    console.log('Testing online devices endpoint...');
    
    const response = await axios.post('http://localhost:3000/api/stream/online', {}, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('Response:', response.data);
  } catch (error) {
    console.log('Error details:');
    console.log('Status:', error.response?.status);
    console.log('Data:', error.response?.data);
    console.log('Message:', error.message);
  }
}

debugOnline();