const http = require('http');
const options = { hostname: 'localhost', port: 3002, path: '/api/alerts/active?limit=100', headers: { 'x-internal-key': 'srs-internal-2026' } };
http.get(options, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    const alerts = JSON.parse(data).alerts || [];
    const map = {};
    alerts.forEach(a => { map[a.alert_type] = a.severity; });
    console.log(JSON.stringify(map, null, 2));
  });
});
