const http = require('http');
const data = JSON.stringify({});
const req = http.request('http://localhost:3002/api/stream/online', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
}, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    const j = JSON.parse(body);
    console.log('Total online:', j.data?.totalOnline);
    (j.data?.devices || []).forEach(v => console.log(v.plateName, v.online ? 'ONLINE' : 'OFFLINE', v.lastSeen?.slice(0, 16)));
  });
});
req.write(data);
req.end();
