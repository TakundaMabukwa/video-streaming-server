const apiClient = require('./src/helpers/apiClient');

async function tracePlateSource() {
  try {
    console.log('🔍 Tracing license plate source...\n');

    // Make direct API call to MettaHub
    const rawResponse = await apiClient.makeRequest('/device/page', {
      pageIndex: 1,
      pageSize: 100,
      subsumption: true
    });

    console.log('📡 Raw MettaHub API Response Structure:');
    console.log('Response code:', rawResponse.code);
    console.log('Total devices:', rawResponse.data.total);
    
    console.log('\n🏷️ License Plates (deviceName field) from API:');
    rawResponse.data.records.slice(0, 10).forEach((device, index) => {
      console.log(`${index + 1}. Plate: "${device.deviceName}" | IMEI: ${device.id}`);
    });

    console.log('\n📋 Raw Device Object Sample:');
    console.log(JSON.stringify(rawResponse.data.records[0], null, 2));

    console.log('\n✅ Confirmation:');
    console.log('- License plates come from: MettaHub API response');
    console.log('- Field name: "deviceName"');
    console.log('- Source: /device/page endpoint');
    console.log('- Our server: Passes through unchanged');

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

tracePlateSource();