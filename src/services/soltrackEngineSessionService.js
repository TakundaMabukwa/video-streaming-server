const db = require('../db');
const {
  planFatigueThresholds,
  emitDeviceStatusAlert,
  distanceOverTrail,
} = require('./deviceStatusPoller');

const RESUME_GAP_MS = 5 * 60 * 1000;
const EVAL_MIN_MS = 15000;
const MAX_STATES = 5000;

const THRESHOLD_LABELS = {
  180: 'Driver Fatigue 3h',
  360: 'Driver Fatigue 6h',
  480: '8 Hour Duration Check',
  540: 'Driver fatigue 9h',
  720: '12 Hour Duration Check',
  900: '15 Hour Duration Check',
};

const states = new Map();
const locks = new Map();

function parseThresholdCodes(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseEngineStatus(status) {
  const raw = String(status || '').trim();
  if (!raw) return null;
  const value = raw.toLowerCase();
  let engine = null;
  let ignition = null;

  if (/(^|~)\s*engine\s+on\b/.test(value)) engine = 'on';
  else if (/(^|~)\s*engine\s+off\b/.test(value)) engine = 'off';

  if (/(^|~)\s*ignition\s+on\b/.test(value)) ignition = 'on';
  else if (/(^|~)\s*ignition\s+off\b/.test(value)) ignition = 'off';

  if (!engine && !ignition) return null;
  return { engine, ignition };
}

function runExclusive(fleet, fn) {
  const previous = locks.get(fleet) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  locks.set(fleet, current);
  current.finally(() => {
    if (locks.get(fleet) === current) locks.delete(fleet);
  }).catch(() => {});
  return current;
}

async function getOpenSession(fleet) {
  const result = await db.query(
    `SELECT * FROM soltrack_engine_sessions
      WHERE device_id = $1 AND engine_off_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [fleet]
  );
  return result.rows[0] || null;
}

async function getLatestClosedSession(fleet) {
  const result = await db.query(
    `SELECT * FROM soltrack_engine_sessions
      WHERE device_id = $1 AND engine_off_at IS NOT NULL
      ORDER BY engine_off_at DESC, id DESC LIMIT 1`,
    [fleet]
  );
  return result.rows[0] || null;
}

async function ensureState(fleet) {
  let state = states.get(fleet);
  if (!state) {
    state = {
      session: null,
      thresholds: [],
      engineOn: null,
      ignitionOn: null,
      lastEvalAt: 0,
      lastSeen: 0,
    };
    states.set(fleet, state);
  }

  if (!state.session) {
    const open = await getOpenSession(fleet);
    if (open) {
      state.session = open;
      state.thresholds = parseThresholdCodes(open.fatigue_alerted_thresholds);
      state.engineOn = true;
    }
  }

  state.lastSeen = Date.now();
  if (states.size > MAX_STATES) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, value] of states) {
      if (value.lastSeen < cutoff) states.delete(key);
    }
  }
  return state;
}

async function updateVehicleState({ fleetNumber, registration, engineOn, ignitionOn }) {
  await db.query(
    `INSERT INTO vehicle_status
       (device_id, plate, license_plate, fleet_number, engine_on, ignition_on, last_update)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       plate = COALESCE(EXCLUDED.plate, vehicle_status.plate),
       license_plate = COALESCE(EXCLUDED.license_plate, vehicle_status.license_plate),
       fleet_number = COALESCE(EXCLUDED.fleet_number, vehicle_status.fleet_number),
       engine_on = CASE WHEN $5::boolean IS NULL THEN vehicle_status.engine_on ELSE $5::boolean END,
       ignition_on = CASE WHEN $6::boolean IS NULL THEN vehicle_status.ignition_on ELSE $6::boolean END,
       last_update = NOW()`,
    [fleetNumber, registration || null, registration || null, fleetNumber, engineOn, ignitionOn]
  ).catch((err) => console.error('[SOLTRACK-ENGINE] vehicle state update failed:', err.message));
}

async function startOrResumeSession(state, { fleetNumber, registration, costCenterId, when }) {
  if (state.session && state.session.engine_off_at == null) return state.session;

  const previous = await getLatestClosedSession(fleetNumber);
  const lastOff = previous?.last_off_at || previous?.engine_off_at;
  const resume = previous && lastOff && when.getTime() - new Date(lastOff).getTime() < RESUME_GAP_MS;

  if (resume) {
    const result = await db.query(
      `UPDATE soltrack_engine_sessions
          SET engine_off_at = NULL,
              last_on_at = $2,
              cost_center_id = COALESCE($3, cost_center_id),
              updated_at = NOW()
        WHERE id = $1 AND engine_off_at IS NOT NULL
        RETURNING *`,
      [previous.id, when.toISOString(), costCenterId ?? null]
    );
    if (result.rows[0]) {
      state.session = result.rows[0];
      state.thresholds = parseThresholdCodes(result.rows[0].fatigue_alerted_thresholds);
      return state.session;
    }
  }

  const result = await db.query(
    `INSERT INTO soltrack_engine_sessions
       (device_id, fleet_number, registration_number, cost_center_id,
        engine_on_at, last_on_at, fatigue_alerted_thresholds)
     VALUES ($1, $2, $3, $4, $5, $5, '[]')
     RETURNING *`,
    [fleetNumber, fleetNumber, registration || null, costCenterId ?? null, when.toISOString()]
  );
  state.session = result.rows[0] || null;
  state.thresholds = [];
  return state.session;
}

async function pauseSession(state, when) {
  if (!state.session || state.session.engine_off_at != null) return state.session;
  const result = await db.query(
    `UPDATE soltrack_engine_sessions
        SET accumulated_on_seconds = accumulated_on_seconds
              + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - last_on_at)))::bigint),
            last_off_at = $2,
            engine_off_at = $2,
            updated_at = NOW()
      WHERE id = $1 AND engine_off_at IS NULL
      RETURNING *`,
    [state.session.id, when.toISOString()]
  );
  if (result.rows[0]) state.session = result.rows[0];
  return state.session;
}

async function saveThresholds(sessionId, codes, when) {
  await db.query(
    `UPDATE soltrack_engine_sessions
        SET fatigue_alerted_thresholds = $2,
            last_evaluated_at = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [sessionId, JSON.stringify(codes), when.toISOString()]
  );
}

async function evaluateEngineThresholds({ fleetNumber, registration, lat, lon, speed, eventTime }) {
  const fleet = String(fleetNumber || '').trim();
  if (!fleet) return null;
  const when = eventTime ? new Date(eventTime) : new Date();
  if (Number.isNaN(when.getTime())) return null;

  return runExclusive(fleet, async () => {
    const state = await ensureState(fleet);
    if (!state.session || state.session.engine_off_at != null) return null;
    if (state.lastEvalAt && when.getTime() - state.lastEvalAt < EVAL_MIN_MS) return null;
    state.lastEvalAt = when.getTime();

    const lastOn = new Date(state.session.last_on_at).getTime();
    if (!Number.isFinite(lastOn)) return null;
    const currentOnSeconds = Math.max(0, (when.getTime() - lastOn) / 1000);
    const curMinutes = (Number(state.session.accumulated_on_seconds) + currentOnSeconds) / 60;
    if (!Number.isFinite(curMinutes) || curMinutes < 0) return null;

    const plan = planFatigueThresholds({
      codes: state.thresholds,
      curMinutes,
      currDriving: true,
    });

    const next = [...state.thresholds];
    for (const code of plan.skip || []) {
      if (!next.includes(code)) next.push(code);
    }

    let changed = (plan.skip || []).length > 0;
    if (plan.fire.length > 0) {
      const threshold = plan.fire[0];
      const sessionKm = await distanceOverTrail(
        fleet,
        state.session.engine_on_at,
        when.toISOString(),
        { lat, lon, t: when.getTime() }
      ).catch(() => null);
      const label = THRESHOLD_LABELS[threshold.minutes] || threshold.signalCode;

      const groupRow = await emitDeviceStatusAlert({
        deviceId: fleet,
        fleetNumber: fleet,
        licensePlate: registration || null,
        signalCode: threshold.signalCode,
        alarmText: `${label} exceeded (${threshold.minutes} min)`,
        lat,
        lon,
        speed,
        ts: when,
        extra: { drivingMinutes: Math.round(curMinutes), source: 'soltrack-engine' },
        distanceKm: sessionKm,
        durationSeconds: Math.round(curMinutes * 60),
      });

      if (groupRow) {
        next.push(threshold.signalCode);
        changed = true;
      }
    }

    if (changed) {
      state.thresholds = [...new Set(next)];
      await saveThresholds(state.session.id, state.thresholds, when);
    }

    return { curMinutes, thresholds: state.thresholds, fired: plan.fire };
  });
}

async function handleEngineStatus({
  fleetNumber,
  registration,
  costCenterId,
  status,
  eventTime,
  speed,
  lat,
  lon,
}) {
  const fleet = String(fleetNumber || '').trim();
  if (!fleet) return null;
  const parsed = parseEngineStatus(status);
  if (!parsed) return null;
  const when = eventTime ? new Date(eventTime) : new Date();
  if (Number.isNaN(when.getTime())) return null;

  return runExclusive(fleet, async () => {
    const state = await ensureState(fleet);
    if (parsed.engine) state.engineOn = parsed.engine === 'on';
    if (parsed.ignition) state.ignitionOn = parsed.ignition === 'on';

    await updateVehicleState({
      fleetNumber: fleet,
      registration,
      engineOn: parsed.engine ? parsed.engine === 'on' : null,
      ignitionOn: parsed.ignition ? parsed.ignition === 'on' : null,
    });

    if (parsed.engine === 'on' || parsed.ignition === 'on') {
      await startOrResumeSession(state, { fleetNumber: fleet, registration, costCenterId, when });
    } else if (parsed.engine === 'off' || parsed.ignition === 'off') {
      await pauseSession(state, when);
    }

    return state;
  });
}

module.exports = {
  handleEngineStatus,
  evaluateEngineThresholds,
  parseEngineStatus,
};
