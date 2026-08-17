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
app.use(cors({ origin: true, credentials: true }));
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
    const syncService = require('./services/syncService');
    server = app.listen(config.port, async () => {
      console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
      try {
        await syncService.startAutoSync(60000);
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
