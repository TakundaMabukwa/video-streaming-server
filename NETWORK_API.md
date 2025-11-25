# Network Devices API

## 🌐 Get All Devices Under Network

### Endpoint:
```bash
GET /api/stream/network
```

### Response:
```json
{
  "success": true,
  "message": "Network devices retrieved successfully",
  "data": {
    "totalDevices": 21,
    "customer": {
      "id": "1934955621319770112",
      "customerName": "EPS",
      "customerType": "2"
    },
    "devices": [
      {
        "plateName": "JR30SZGP",
        "deviceId": "353076703338",
        "deviceType": "MC904",
        "cameras": 5,
        "activeTime": "2025-06-17 10:48:04",
        "expirationTime": "2026-06-16 09:06:04",
        "timezone": "UTC+02:00",
        "customerName": "EPS"
      }
    ],
    "deviceTypes": ["MC904"],
    "totalCameras": 105
  }
}
```

## 📊 Network Summary:
- **Customer**: EPS
- **Total Devices**: 21
- **Total Cameras**: 105 (21 × 5 cameras each)
- **Device Type**: MC904 (GPS tracker with cameras)

## 🚗 All Available Plates:
1. JR30SZGP, JY54WJGP, MK88LTGP, MK88RHGP
2. MK88MLGP, MK88LKGP, MK88MPGP, MK88PSGP
3. JL64ZGGP, JK68DMGP, JF74YXGP, HS30WSGP
4. HY87GLGP, JL65CPGP, JL64YJGP, HW22SFGP
5. HY74XFGP, KY69YCGP, JF74XGGP, JF74XHGP
6. JY54XJGP

## 🔧 Usage:
```bash
# Get network overview
curl http://localhost:3000/api/stream/network

# Or use in JavaScript
fetch('/api/stream/network')
  .then(res => res.json())
  .then(data => console.log(data.data));
```

**Restart your server** to use this new endpoint:
```bash
npm run dev
```