const { WebSocketServer } = require('ws');

let wss = null;
const clients = new Set();

function startWebSocket(port = 3004) {
  wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg && msg.type) {
          const envelope = JSON.stringify({ type: msg.type, data: msg.data || {}, timestamp: new Date().toISOString() });
          for (const other of clients) {
            if (other !== ws && other.readyState === 1) {
              try { other.send(envelope); } catch (_) { /* skip */ }
            }
          }
        }
      } catch (_) { /* ignore non-JSON */ }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', data: { timestamp: new Date().toISOString() } }));
  });

  // Heartbeat every 30s to detect dead connections
  const heartbeat = setInterval(() => {
    if (!wss) { clearInterval(heartbeat); return; }
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { clients.delete(ws); return ws.terminate(); }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  console.log(`[WS] WebSocket server started on port ${port}`);
}

function broadcast(eventType, data) {
  if (clients.size === 0) return;
  const message = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(message);
    } catch (e) {
      clients.delete(ws);
    }
  }
}

function stopWebSocket() {
  if (wss) {
    wss.close();
    wss = null;
    clients.clear();
  }
}

module.exports = { startWebSocket, broadcast, stopWebSocket };
