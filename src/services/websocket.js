const http = require('http');
const { WebSocketServer } = require('ws');
const { joinAlert, leaveAlert } = require('./presence');
const { createClient } = require('@supabase/supabase-js');

let wss = null;
let httpServer = null;
const clients = new Set();
let supabaseAdmin = null;

function getSupabaseAdmin() {
  if (!supabaseAdmin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabaseAdmin;
}

// Every WS client must prove identity: ?token=<supabase access_token>.
// Mirrors HTTP requireAuth (token → auth.getUser → users row). Checked on
// HTTP upgrade, before the socket exists — rejected clients get 401 and
// never join. (ws@8 removed the verifyClient option, hence manual upgrade.)
async function verifyWsToken(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return null;
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    const { data: row, error: rowErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', user.id)
      .single();
    if (rowErr || !row) return null;
    return { id: user.id, email: user.email || null };
  } catch {
    return null;
  }
}

function startWebSocket(port = 3004) {
  wss = new WebSocketServer({ noServer: true });
  httpServer = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  httpServer.on('upgrade', async (req, socket, head) => {
    const identity = await verifyWsToken(req);
    if (!identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.wsUserId = identity.id;
      wss.emit('connection', ws, req);
    });
  });
  httpServer.listen(port);

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)${ws.wsUserId ? ` user=${ws.wsUserId}` : ''}`);

    ws.isAlive = true;
    ws._presenceJoins = new Map(); // alertId -> user, to clean up on disconnect
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg && msg.type) {
          const data = msg.data || {};
          const alertId = String(data.alertId || data.alert_id || '').trim();
          const user = String(data.user || '').trim();
          if (msg.type === 'alert-user-active') {
            if (alertId && user) {
              joinAlert(alertId, user);
              ws._presenceJoins.set(alertId, user);
            }
          } else if (msg.type === 'alert-user-inactive') {
            if (alertId && user) {
              leaveAlert(alertId, user);
              if (ws._presenceJoins.get(alertId) === user) {
                ws._presenceJoins.delete(alertId);
              }
            }
          }
          // Targeted relay: only send presence events to clients that are
          // currently viewing the SAME alert. Non-viewers receive nothing.
          if (alertId) {
            const envelope = JSON.stringify({ type: msg.type, data, timestamp: new Date().toISOString() });
            for (const other of clients) {
              if (other !== ws && other.readyState === 1 && other._presenceJoins && other._presenceJoins.has(alertId)) {
                try { other.send(envelope); } catch (_) { /* skip */ }
              }
            }
          }
        }
      } catch (_) { /* ignore non-JSON */ }
    });

    const cleanupPresence = () => {
      const joins = ws._presenceJoins;
      ws._presenceJoins = new Map();
      for (const [alertId, user] of joins) {
        leaveAlert(alertId, user);
      }
    };

    ws.on('close', () => {
      cleanupPresence();
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
      cleanupPresence();
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
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

module.exports = { startWebSocket, broadcast, stopWebSocket };
