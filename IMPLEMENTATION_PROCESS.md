# Video Feed Implementation Process

## 🗺️ Map Display Process

### Step 1: Get Vehicle Data
```javascript
// Get all vehicles with location data
const response = await fetch('/api/stream/network');
const { vehicles } = response.data;
```

### Step 2: Extract Coordinates
```javascript
// Each vehicle should have GPS coordinates
vehicles.forEach(vehicle => {
  const { plateName, latitude, longitude, cameras } = vehicle;
  // Add marker to map
});
```

### Step 3: Create Map Markers
```javascript
// Using Leaflet.js or Google Maps
const marker = L.marker([latitude, longitude])
  .bindPopup(`
    <b>${plateName}</b><br>
    Cameras: ${cameras}<br>
    <button onclick="viewStreams('${deviceId}')">View Streams</button>
  `);
```

## 🎥 Stream Display Process

### Step 1: Get All Live Streams
```javascript
const response = await fetch('/api/stream/vehicles/streams', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    allChannels: true,
    onlineOnly: true,
    timeout: 5000
  })
});
```

### Step 2: Create Video Players
```javascript
vehicle.channels.forEach(channel => {
  const video = document.createElement('video');
  const player = flvjs.createPlayer({
    type: 'flv',
    url: `/api/stream/stream/proxy?url=${encodeURIComponent(channel.streamUrl)}`,
    isLive: true
  });
  player.attachMediaElement(video);
  player.load();
  player.play();
});
```

### Step 3: Handle Persistent Connections
```javascript
// Auto-reconnect on errors
player.on(flvjs.Events.ERROR, () => {
  setTimeout(() => reconnect(), 2000);
});

// Keep-alive mechanism
setInterval(() => {
  if (video.paused) player.play();
}, 10000);
```

## 🏗️ Architecture Flow

```
1. Client Request → Express Server
2. Server → External API (mettaxiot.com)
3. API Response → Controller Processing
4. Processed Data → Client Response
5. Client → FLV.js Player → Video Display
6. Persistent Connection Management
```

## 📱 Integration Steps for Next App

### Backend Setup
1. Copy `src/` folder structure
2. Update `config/config.js` with new API base URL
3. Modify controllers for your data model
4. Update routes as needed

### Frontend Integration
1. Include FLV.js: `npm install flv.js`
2. Use persistent player function
3. Call API endpoints for data
4. Display videos with auto-reconnect

### Map Integration (if needed)
1. Add GPS coordinates to vehicle data
2. Use Leaflet.js or Google Maps
3. Create markers with stream popup
4. Link markers to video players

## 🔄 Data Flow Summary

```
GET /network → All Vehicles
POST /vehicles/streams → Live Streams
GET /stream/proxy → Video Data
FLV.js → Video Display
Auto-reconnect → Persistent Connection
```