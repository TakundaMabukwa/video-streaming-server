const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./config/config');
const routes = require('./routes');
const { sendError } = require('./helpers/response');
const { requireAuth } = require('./middleware/auth');
const db = require('./db');
const app = express();

app.use(compression());

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
}));
const ALLOWED_ORIGINS = [
  'https://soteriarisksolutions.online',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin/proxy, curl and non-browser clients have no Origin.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static('public', { maxAge: '1d' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter, requireAuth, routes);

app.use('*', (req, res) => {
  sendError(res, 'Route not found', 404);
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return sendError(res, 'Request body too large', 413);
  }
  console.error(err.stack);
  sendError(res, 'Something went wrong!', 500);
});

async function waitForDb(retries = 30, delay = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await db.initializeDatabase();
      console.log('[DB] Database ready');
      return;
    } catch (err) {
      if (i < retries) {
        console.log(`[DB] Connection attempt ${i}/${retries} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function shutdown(signal) {
  console.log(`[SERVER] Received ${signal}, shutting down gracefully...`);
  try {
    const syncService = require('./services/syncService');
    syncService.stopAutoSync();
  } catch {}
  try {
    const geotabPolling = require('./services/geotabPolling');
    geotabPolling.stopPolling();
  } catch {}
  try {
    const { stopWebSocket } = require('./services/websocket');
    stopWebSocket();
  } catch {}
  try {
    const soltrackClient = require('./services/soltrackClient');
    soltrackClient.stop();
  } catch {}
  try {
    const { stopMidnightCron } = require('./services/driverScoringService');
    stopMidnightCron();
  } catch {}
  server.close(async () => {
    await db.closePool();
    console.log('[SERVER] Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[SERVER] Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

let server;
async function start() {
  try {
    await waitForDb();

    // Initialize driver scoring from vehiclesc + drivers
    try {
      const { initializeDriverScoring, startMidnightCron } = require('./services/driverScoringService');
      await initializeDriverScoring();
      startMidnightCron();
    } catch (err) {
      console.error(`[DriverScoring] Init failed: ${err.message}`);
    }

    // Sweep stale alert-watch heartbeats every 5 minutes (90s TTL).
    try {
      const dbAlertController = require('./controllers/dbAlertController');
      setInterval(() => { dbAlertController.sweepStaleWatchers(); }, 5 * 60 * 1000).unref?.();
    } catch (err) {
      console.error(`[WATCH] Sweep init failed: ${err.message}`);
    }

    // Start RTMS driving time monitoring
    try {
      const rtmsService = require('./services/rtmsService');
      rtmsService.startMonitoring(60000);
      // Pass broadcast to RTMS after websocket starts
      const { broadcast } = require('./services/websocket');
      rtmsService.setBroadcast(broadcast);
    } catch (err) {
      console.error(`[RTMS] Init failed: ${err.message}`);
    }

    // Start WebSocket server
    const { startWebSocket, broadcast } = require('./services/websocket');
    try {
      startWebSocket(3004);
    } catch (err) {
      console.error(`[WS] WebSocket failed to start: ${err.message}`);
    }

    // NCR email outbox sweeper: background delivery with retry.
    try {
      require('./services/ncrEmailSweeper').start();
    } catch (err) {
      console.error(`[NCR-OUTBOX] sweeper failed to start: ${err.message}`);
    }

    // Vehicle alert overrides: warm the in-memory cache so the detection
    // path never queries for it.
    try {
      require('./services/vehicleAlertOverrides').start();
    } catch (err) {
      console.error(`[OVERRIDES] cache failed to start: ${err.message}`);
    }

    // Background job runner: NCR closures + escalation emails + incident
    // footage capture — everything the user must never wait for.
    try {
      require('./services/jobRunner').start();
    } catch (err) {
      console.error(`[JOBS] runner failed to start: ${err.message}`);
    }

    // Footage watcher: the camera uploads the clip in its own time; this
    // picks up the link as soon as the file is there.
    try {
      require('./services/alertFootageService').startWatcher();
    } catch (err) {
      console.error(`[FOOTAGE] watcher failed to start: ${err.message}`);
    }

    // Start Geotab polling (connects WebSocket broadcast)
    try {
      const geotabPolling = require('./services/geotabPolling');
      geotabPolling.setWsBroadcast(broadcast);
      geotabPolling.startPolling(60000, 15000);
    } catch (err) {
      console.error(`[GEOTAB] Polling failed to start: ${err.message}`);
    }

    // Connect broadcast to alert controller for real-time resolve/close notifications
    try {
      const dbAlertController = require('./controllers/dbAlertController');
      dbAlertController.setWsBroadcast(broadcast);
    } catch (err) {
      console.error(`[AlertController] Broadcast init failed: ${err.message}`);
    }

    // Start Soltrack telematics client (WebSocket feed - realtime, no polling)
    try {
      const soltrackClient = require('./services/soltrackClient');
      soltrackClient.setWsBroadcast(broadcast);
      soltrackClient.start();
    } catch (err) {
      console.error(`[SOLTRACK] Client init failed: ${err.message}`);
    }

    const syncService = require('./services/syncService');
    syncService.setWsBroadcast(broadcast);
    server = app.listen(config.port, async () => {
      console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
    // Video alarms every 15s — each cycle is ~6s, so this keeps wall-clock
    // delay for a new Metax/Skycamx alert near one interval (not 30s+runtime).
    try {
      await syncService.startAutoSync(15000);
    } catch (err) {
      console.error(`[SYNC] Auto-sync failed to start: ${err.message}`);
    }
    });
    server.setTimeout(30000);
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
