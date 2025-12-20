# Vehicle Streams Troubleshooting

## Issue: Empty Channels Array

**Problem:** Vehicle JL65CPGP returns `channels: []` instead of stream URLs

**Root Cause:** 
- Default timeout (5000ms) is too short for API responses
- Sequential channel requests take time
- API rate limiting or slow responses

## Solution

### 1. Increase Timeout
```json
{
  "allChannels": true,
  "onlineOnly": false,
  "timeout": 10000,
  "includeOffline": true
}
```

### 2. Test Individual Vehicle
```bash
curl -X POST http://161.35.25.105:3000/api/stream/debug/vehicle \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"628074815068"}'
```

### 3. Response Format (Fixed)
```json
{
  "success": true,
  "data": {
    "totalVehicles": 6,
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
          }
        ],
        "cameras": 5,
        "availableChannels": 2,
        "customerName": "EPS"
      }
    ]
  }
}
```

## Debug Endpoint

**Test specific vehicle channels:**
```
POST /api/stream/debug/vehicle
{
  "deviceId": "628074815068"
}
```

**Response shows each channel status:**
```json
{
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
    }
  ],
  "successCount": 5
}
```

## Recommended Settings

```json
{
  "allChannels": true,
  "onlineOnly": false,
  "timeout": 10000,
  "includeOffline": true
}
```

- **timeout**: 10000ms (10 seconds) for all channels
- **allChannels**: true to get all cameras
- **includeOffline**: true to include vehicles without streams
