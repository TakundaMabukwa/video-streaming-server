# Vehicle Video Streaming API

## 🚗 Vehicle Live Video Streams

### Get All Vehicles with Live Video Streams

**Endpoint:**
```
POST /api/stream/vehicles/streams
```

**Request Body:**
```json
{
  "allChannels": true,
  "onlineOnly": true,
  "timeout": 5000
}
```

**Response Format:**
```json
{
  "success": true,
  "message": "All vehicles with streams retrieved successfully",
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
          },
          {
            "channelId": 3,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074833939_3.live.flv"
          },
          {
            "channelId": 4,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074833939_4.live.flv"
          },
          {
            "channelId": 5,
            "streamUrl": "https://m1.mettaxiot.com/mettax/video/628074833939_5.live.flv"
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

## 🎥 Video Stream Details

**Stream Format:** FLV (Flash Video)
**Protocol:** HTTPS
**Type:** Live streaming
**Channels:** 1-5 cameras per vehicle

## 📡 Stream Proxy (Required for Web)

**Endpoint:**
```
GET /api/stream/stream/proxy?url={encoded_stream_url}
```

**Usage:**
```javascript
const proxyUrl = `/api/stream/stream/proxy?url=${encodeURIComponent(streamUrl)}`;
```

## 🔧 Implementation

### 1. Install Dependencies
```bash
npm install flv.js
```

### 2. Get Vehicle Streams
```javascript
const response = await fetch('/api/stream/vehicles/streams', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    allChannels: true,
    onlineOnly: true
  })
});

const { vehicles } = await response.json();
```

### 3. Display Videos
```javascript
vehicles.forEach(vehicle => {
  vehicle.channels.forEach(channel => {
    const video = document.createElement('video');
    const player = flvjs.createPlayer({
      type: 'flv',
      url: `/api/stream/stream/proxy?url=${encodeURIComponent(channel.streamUrl)}`,
      isLive: true,
      hasAudio: false
    });
    
    player.attachMediaElement(video);
    player.load();
    player.play();
  });
});
```

### 4. Persistent Connection
```javascript
// Auto-reconnect on errors
player.on(flvjs.Events.ERROR, () => {
  setTimeout(() => {
    player.load();
    player.play();
  }, 2000);
});
```

## 🚙 Vehicle Data Structure

Each vehicle contains:
- **plateName**: Vehicle license plate
- **deviceId**: Unique device identifier
- **channels**: Array of camera streams
- **cameras**: Total camera count
- **customerName**: Owner/operator name

## 📱 Integration Example

```javascript
// Get all vehicle streams
async function getVehicleStreams() {
  const response = await fetch('/api/stream/vehicles/streams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allChannels: true, onlineOnly: true })
  });
  
  const data = await response.json();
  return data.data.vehicles;
}

// Display vehicle cameras
function displayVehicleCameras(vehicle) {
  console.log(`Vehicle: ${vehicle.plateName}`);
  console.log(`Cameras: ${vehicle.channels.length}/${vehicle.cameras}`);
  
  vehicle.channels.forEach(camera => {
    console.log(`Camera ${camera.channelId}: ${camera.streamUrl}`);
  });
}
```

## ⚡ Quick Start

1. **Get vehicles**: `POST /api/stream/vehicles/streams`
2. **Extract streams**: `vehicle.channels[].streamUrl`
3. **Use proxy**: `/api/stream/stream/proxy?url=...`
4. **Play with FLV.js**: Create persistent players
5. **Handle reconnects**: Auto-retry on errors

## 🔄 Stream URLs Format

```
https://m1.mettaxiot.com/mettax/video/{deviceId}_{channelId}.live.flv
```

Example:
- Camera 1: `628074833939_1.live.flv`
- Camera 2: `628074833939_2.live.flv`
- Camera 3: `628074833939_3.live.flv`