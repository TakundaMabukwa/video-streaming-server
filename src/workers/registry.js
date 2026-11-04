// Worker registry: one scheduler per responsibility, in-flight guard, watchdog
// and health. Workers are logical modules in the main process for now; the
// same interface can be hosted in a worker_thread without changing callers.

const workers = new Map();

function registerWorker({ name, intervalMs, runOnce, watchdogMs = 0 }) {
  if (!name || typeof runOnce !== 'function') throw new Error('worker needs a name and runOnce');
  if (workers.has(name)) return workers.get(name);
  const worker = {
    name,
    intervalMs: Math.max(1000, Number(intervalMs) || 15000),
    runOnce,
    watchdogMs: Math.max(0, Number(watchdogMs) || 0),
    timer: null,
    running: false,
    startedAt: 0,
    lastStartedAt: 0,
    lastEndedAt: 0,
    lastMs: 0,
    lastError: null,
    runs: 0,
    skipped: 0,
    generation: 0,
  };
  workers.set(name, worker);
  return worker;
}

function schedule(worker) {
  if (!worker.timer && worker.intervalMs > 0) {
    worker.timer = setTimeout(() => tick(worker), worker.intervalMs);
    if (typeof worker.timer.unref === 'function') worker.timer.unref();
  }
}

async function tick(worker) {
  worker.timer = null;
  if (worker.running) {
    worker.skipped += 1;
    schedule(worker);
    return;
  }
  worker.running = true;
  const gen = ++worker.generation;
  worker.startedAt = Date.now();
  worker.lastStartedAt = worker.startedAt;
  try {
    await worker.runOnce();
    worker.lastError = null;
  } catch (err) {
    worker.lastError = String(err.message || err);
    console.error(`[WORKER:${worker.name}]`, worker.lastError);
  } finally {
    if (gen === worker.generation) {
      worker.running = false;
      worker.lastEndedAt = Date.now();
      worker.lastMs = worker.lastEndedAt - worker.startedAt;
      worker.runs += 1;
    }
    schedule(worker);
  }
}

function startAll() {
  for (const worker of workers.values()) {
    if (worker.timer) continue;
    tick(worker);
  }
}

function stopAll() {
  for (const worker of workers.values()) {
    if (worker.timer) clearTimeout(worker.timer);
    worker.timer = null;
  }
}

async function runOnce(name) {
  const worker = workers.get(name);
  if (!worker) throw new Error(`unknown worker: ${name}`);
  await tick(worker);
}

function getHealth() {
  return Array.from(workers.values()).map((w) => ({
    name: w.name,
    intervalMs: w.intervalMs,
    running: w.running,
    lastStartedAt: w.lastStartedAt ? new Date(w.lastStartedAt).toISOString() : null,
    lastEndedAt: w.lastEndedAt ? new Date(w.lastEndedAt).toISOString() : null,
    lastMs: w.lastMs,
    lastError: w.lastError,
    runs: w.runs,
    skipped: w.skipped,
  }));
}

module.exports = { registerWorker, startAll, stopAll, runOnce, getHealth };
