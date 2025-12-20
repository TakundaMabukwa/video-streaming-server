# Video Feed API Endpoints

## 🚗 Vehicle & Stream Endpoints

### Get All Vehicles with All Cameras
```
POST /api/stream/vehicles/streams
{
  "allChannels": true,
  "onlineOnly": true,
  "timeout": 5000
}
```

### Get All Network Devices
```
GET /api/stream/network
```

### Get Online Devices Only
```
POST /api/stream/online
{
  "customerId": null
}
```

### Get Single Vehicle Stream
```
POST /api/stream/live
{
  "deviceId": "628074833939",
  "channelId": 1,
  "bitstreamType": 1
}
```

### Get Stream by Plate Name
```
POST /api/stream/live/plate
{
  "plateName": "MK88LTGP",
  "channelId": 1,
  "bitstreamType": 1
}
```

### Get Customer Tree
```
POST /api/stream/customers
{
  "customerId": null
}
```

### Stream Proxy (for CORS)
```
GET /api/stream/stream/proxy?url={encoded_stream_url}
```

## 📊 Response Format

### Vehicles with All Cameras
```json
{
  "success": true,
  "data": {
    "totalVehicles": 6,
    "vehicles": [
      {
        "plateName": "MK88LTGP",
        "deviceId": "628074833939",
        "channels": [
          {
            "channelId": 1,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074833939_1.live.flv"
          },
          {
            "channelId": 2,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074833939_2.live.flv"
          }
        ],
        "cameras": 5,
        "deviceType": "vehicle",
        "customerName": "EPS"
      }
    ]
  }
}
```

### Network Devices
```json
{
  "success": true,
  "data": {
    "totalDevices": 22,
    "devices": [
      {
        "plateName": "MK88LTGP",
        "deviceId": "628074833939",
        "cameras": 5,
        "customerName": "EPS"
      }
    ]
  }
}
```