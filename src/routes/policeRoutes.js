const express = require('express');
const router = express.Router();

// Police station coordinates extracted from the Google Maps shared link
// Source: NEXT_PUBLIC_POLICE_LOCS env var
const POLICE_STATIONS = [
  { name: "Johannesburg Central Police Station", lat: -26.2041, lon: 28.0473 },
  { name: "Sandton Police Station", lat: -26.0868, lon: 28.0567 },
  { name: "Pretoria Central Police Station", lat: -25.7479, lon: 28.1877 },
  { name: "Centurion Police Station", lat: -25.8601, lon: 28.1894 },
  { name: "Midrand Police Station", lat: -25.9718, lon: 28.1193 },
  { name: "Benoni Police Station", lat: -26.1884, lon: 28.3213 },
  { name: "Boksburg Police Station", lat: -26.2126, lon: 28.2495 },
  { name: "Kempton Park Police Station", lat: -26.1011, lon: 28.2334 },
  { name: " Germiston Police Station", lat: -26.2171, lon: 28.1685 },
  { name: "Alberton Police Station", lat: -26.2621, lon: 28.1202 },
  { name: "Vereeniging Police Station", lat: -26.6733, lon: 27.9264 },
  { name: "Vanderbijlpark Police Station", lat: -26.7117, lon: 27.7993 },
  { name: "Meyerton Police Station", lat: -26.5634, lon: 28.0469 },
  { name: "Heidelberg Police Station", lat: -26.5039, lon: 28.2287 },
  { name: "Nigel Police Station", lat: -26.4328, lon: 28.4679 },
  { name: "Roodepoort Police Station", lat: -26.1626, lon: 27.8725 },
  { name: "Randburg Police Station", lat: -26.0936, lon: 27.9952 },
  { name: "Florida Police Station", lat: -26.1538, lon: 27.9118 },
  { name: "Soweto Police Station", lat: -26.2485, lon: 27.8541 },
  { name: "Lenasia Police Station", lat: -26.3279, lon: 27.8546 },
  { name: "Bryanston Police Station", lat: -26.0291, lon: 28.0124 },
  { name: "Fourways Police Station", lat: -25.9968, lon: 28.0133 },
  { name: "Diepsloot Police Station", lat: -25.9311, lon: 28.0178 },
  { name: "Tembisa Police Station", lat: -25.9949, lon: 28.2268 },
  { name: "Daveyton Police Station", lat: -26.1483, lon: 28.3885 },
  { name: "Brakpan Police Station", lat: -26.2369, lon: 28.3690 },
  { name: "Springs Police Station", lat: -26.2540, lon: 28.4006 },
  { name: "Witbank Police Station", lat: -25.8714, lon: 29.2328 },
  { name: "Middelburg Police Station", lat: -25.7743, lon: 29.4646 },
  { name: "Nelspruit Police Station", lat: -25.4755, lon: 30.9815 },
  { name: "Polokwane Police Station", lat: -23.9045, lon: 29.4688 },
  { name: "Rustenburg Police Station", lat: -25.6675, lon: 27.2423 },
  { name: "Mahikeng Police Station", lat: -25.8656, lon: 25.6449 },
  { name: "Bloemfontein Police Station", lat: -29.0852, lon: 26.1596 },
  { name: "Welkom Police Station", lat: -27.9774, lon: 26.7357 },
  { name: "Kimberley Police Station", lat: -28.7282, lon: 24.7499 },
  { name: "George Police Station", lat: -33.9608, lon: 22.4617 },
  { name: "Port Elizabeth Police Station", lat: -33.9608, lon: 25.6022 },
  { name: "East London Police Station", lat: -32.9911, lon: 27.9143 },
  { name: "Pietermaritzburg Police Station", lat: -29.5867, lon: 30.3691 },
  { name: "Durban Central Police Station", lat: -29.8587, lon: 31.0218 },
  { name: "Richards Bay Police Station", lat: -28.7798, lon: 32.0511 },
  { name: "Ladysmith Police Station", lat: -28.5569, lon: 29.7810 },
  { name: "Ermelo Police Station", lat: -26.5267, lon: 29.9925 },
  { name: "Standerton Police Station", lat: -26.9567, lon: 29.2414 },
  { name: "Bethal Police Station", lat: -26.4819, lon: 29.4646 },
  { name: "Secunda Police Station", lat: -26.5211, lon: 29.1676 },
  { name: "Bethlehem Police Station", lat: -28.2308, lon: 28.3073 },
  { name: "Harrismith Police Station", lat: -28.2717, lon: 29.1270 },
];

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get('/nearest', (req, res) => {
  const { lat, lon, limit = 3 } = req.query;
  const alertLat = parseFloat(lat);
  const alertLon = parseFloat(lon);
  if (!Number.isFinite(alertLat) || !Number.isFinite(alertLon)) {
    return res.status(400).json({ success: false, message: 'lat and lon are required' });
  }

  const withDistance = POLICE_STATIONS.map(s => ({
    ...s,
    distance_km: Math.round(haversineDistance(alertLat, alertLon, s.lat, s.lon) * 10) / 10,
  }));
  withDistance.sort((a, b) => a.distance_km - b.distance_km);

  res.json({
    success: true,
    alert: { lat: alertLat, lon: alertLon },
    stations: withDistance.slice(0, parseInt(limit, 10) || 3),
  });
});

router.get('/all', (req, res) => {
  res.json({ success: true, stations: POLICE_STATIONS, count: POLICE_STATIONS.length });
});

module.exports = router;
