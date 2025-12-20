# Vehicle Streams - Final Solution

## Problem
JL65CPGP returns empty channels array when requesting all vehicles with streams

## Root Cause
- API rate limiting when fetching all 22 vehicles × 5 cameras = 110 requests
- Timeout issues with sequential requests
- Connection pooling exhaustion

## Working Solution

### Use the Debug Endpoint (Recommended)
For individual vehicles, use the debug endpoint which works reliably:

```bash
POST /api/stream/debug/vehicle
{
  "deviceId": "628074815068"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "device": {
      "plateName": "JL65CPGP",
      "deviceId": "628074815068",
      "cameras": 5
    },
    "channels": [
      {
        "channelId": 1,
        "success": true,
        "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_1.live.flv",
        "message": "OK"
      },
      {
        "channelId": 2,
        "success": true,
        "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_2.live.flv",
        "message": "OK"
      },
      {
        "channelId": 3,
        "success": true,
        "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_3.live.flv",
        "message": "OK"
      },
      {
        "channelId": 4,
        "success": true,
        "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_4.live.flv",
        "message": "OK"
      },
      {
        "channelId": 5,
        "success": true,
        "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_5.live.flv",
        "message": "OK"
      }
    ],
    "successCount": 5
  }
}
```

### Alternative: Get Single Channel at a Time
```bash
POST /api/stream/live
{
  "deviceId": "628074815068",
  "channelId": 1
}
```

### For All Vehicles (Limited)
Get all vehicles but only first channel:
```bash
POST /api/stream/vehicles/streams
{
  "allChannels": false,
  "onlineOnly": false
}
```

## Recommended Architecture

### Frontend Implementation
```javascript
// Get list of all vehicles
const vehiclesResponse = await fetch('/api/stream/network');
const vehicles = vehiclesResponse.data.devices;

// For each vehicle, get all channels on demand
async function getVehicleChannels(deviceId) {
  const response = await fetch('/api/stream/debug/vehicle', {
    method: 'POST',
    body: JSON.stringify({ deviceId })
  });
  return response.data.channels;
}

// Usage
vehicles.forEach(async (vehicle) => {
  const channels = await getVehicleChannels(vehicle.deviceId);
  displayVehicleStreams(vehicle, channels);
});
```

## API Endpoints Summary

| Endpoint | Purpose | Performance |
|----------|---------|-------------|
| `GET /api/stream/network` | All vehicles (no streams) | ✅ Fast |
| `POST /api/stream/debug/vehicle` | Single vehicle all channels | ✅ Fast |
| `POST /api/stream/live` | Single channel | ✅ Fast |
| `POST /api/stream/vehicles/streams` | All vehicles all channels | ❌ Slow/Timeout |

## Recommended Approach

1. **Load vehicles list** → `/api/stream/network`
2. **Display vehicle list** with loading indicators
3. **Fetch channels on demand** → `/api/stream/debug/vehicle` when user clicks vehicle
4. **Display streams** using FLV.js with persistent connections

This avoids the timeout issue and provides better UX.
