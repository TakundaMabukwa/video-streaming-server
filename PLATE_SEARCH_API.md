# Search by Plate/Device Name API

## New Endpoints Added

### 1. Get Device by Name/Plate
```bash
POST /api/stream/device/name
Content-Type: application/json

{
  "deviceName": "JY54WJGP"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Device found successfully",
  "data": {
    "id": "353076706570",
    "deviceName": "JY54WJGP",
    "deviceType": "MC904",
    "camCount": 5,
    "activeTime": "2025-06-19 11:49:29"
  }
}
```

### 2. Get Live Stream by Plate
```bash
POST /api/stream/live/plate
Content-Type: application/json

{
  "plateName": "JY54WJGP",
  "channelId": 1,
  "bitstreamType": 1
}
```

**Response:**
```json
{
  "success": true,
  "message": "Stream URL retrieved by plate",
  "data": {
    "plateName": "JY54WJGP",
    "deviceId": "353076706570",
    "streamUrl": "https://m1.mettaxiot.com/mettax/video/353076706570_1.live.flv",
    "camCount": 5
  }
}
```

## Usage Examples

### JavaScript/Fetch
```javascript
// Get device info by plate
const device = await fetch('/api/stream/device/name', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceName: 'JY54WJGP' })
});

// Get stream directly by plate
const stream = await fetch('/api/stream/live/plate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    plateName: 'JY54WJGP',
    channelId: 1 
  })
});
```

### cURL
```bash
# Search device by plate
curl -X POST http://localhost:3000/api/stream/device/name \
  -H "Content-Type: application/json" \
  -d '{"deviceName": "JY54WJGP"}'

# Get stream by plate
curl -X POST http://localhost:3000/api/stream/live/plate \
  -H "Content-Type: application/json" \
  -d '{"plateName": "JY54WJGP", "channelId": 1}'
```

## Available Plates
- JR30SZGP, JY54WJGP, MK88LTGP, MK88RHGP
- MK88MLGP, MK88LKGP, MK88MPGP, MK88PSGP
- JL64ZGGP, JK68DMGP, JF74YXGP, HS30WSGP
- HY87GLGP, JL65CPGP, JL64YJGP, HW22SFGP
- HY74XFGP, KY69YCGP, JF74XGGP, JF74XHGP
- JY54XJGP

## Error Handling
- **404**: Vehicle with plate not found
- **400**: Device offline or invalid parameters
- **500**: Server error

Restart your server to use these new endpoints!