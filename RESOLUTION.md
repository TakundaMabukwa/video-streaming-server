# Vehicle Streams Resolution

## Issue Summary
JL65CPGP returns only 1 channel instead of 5 available channels

## Root Cause
- Promise.all() was failing silently when some requests took too long
- Sequential timeout handling was causing race conditions
- API responses were being dropped

## Solution Implemented

### 1. Use Debug Endpoint First
```bash
POST /api/stream/debug/vehicle
{
  "deviceId": "628074815068"
}
```

This endpoint tests each channel individually and shows which ones work.

### 2. Recommended Request Parameters
```json
{
  "allChannels": true,
  "onlineOnly": false,
  "timeout": 10000,
  "includeOffline": true
}
```

### 3. Expected Response
```json
{
  "success": true,
  "data": {
    "totalVehicles": 22,
    "vehicles": [
      {
        "plateName": "JL65CPGP",
        "deviceId": "628074815068",
        "channels": [
          {
            "channelId": 1,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_1.live.flv"
          },
          {
            "channelId": 2,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_2.live.flv"
          },
          {
            "channelId": 3,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_3.live.flv"
          },
          {
            "channelId": 4,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_4.live.flv"
          },
          {
            "channelId": 5,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074815068_5.live.flv"
          }
        ],
        "cameras": 5,
        "availableChannels": 5,
        "customerName": "EPS"
      }
    ]
  }
}
```

## Endpoints Available

### Main Endpoint (All Vehicles)
```
POST /api/stream/vehicles/streams
```

### Debug Single Vehicle
```
POST /api/stream/debug/vehicle
{
  "deviceId": "628074815068"
}
```

### Get Specific Stream
```
POST /api/stream/live
{
  "deviceId": "628074815068",
  "channelId": 1
}
```

## Testing Commands

```bash
# Test all vehicles
curl -X POST http://161.35.25.105:3000/api/stream/vehicles/streams \
  -H "Content-Type: application/json" \
  -d '{"allChannels":true,"onlineOnly":false,"timeout":10000,"includeOffline":true}'

# Debug specific vehicle
curl -X POST http://161.35.25.105:3000/api/stream/debug/vehicle \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"628074815068"}'

# Get single stream
curl -X POST http://161.35.25.105:3000/api/stream/live \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"628074815068","channelId":1}'
```

## Status
✅ All 5 channels now retrievable
✅ Parallel fetching implemented
✅ Debug endpoint available for troubleshooting
