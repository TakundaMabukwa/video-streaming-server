const assert = require('assert');
const db = require('../src/db');
const identity = require('../src/vehicles/identity');
const engine = require('../src/services/soltrackEngineSessionService');

const FLEET = 'SOLTESTENG';
const REG = 'TESTENG1';
const BASE = Date.now() + 3600000;

function at(minutes = 0, seconds = 0) {
  return new Date(BASE + minutes * 60000 + seconds * 1000);
}

async function cleanup() {
  await db.query(`DELETE FROM alert_combo_events WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM alert_groups WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM alerts WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM telematics_events WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM soltrack_engine_sessions WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM vehicle_status WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number = $1`, [FLEET]).catch(() => {});
}

async function status(text, when) {
  return engine.handleEngineStatus({
    fleetNumber: FLEET,
    registration: REG,
    costCenterId: 25,
    status: text,
    eventTime: when,
    speed: 0,
    lat: -26.1,
    lon: 28.2,
  });
}

async function evaluate(when) {
  return engine.evaluateEngineThresholds({
    fleetNumber: FLEET,
    registration: REG,
    lat: -26.1,
    lon: 28.2,
    speed: 0,
    eventTime: when,
  });
}

async function openSession() {
  const result = await db.query(
    `SELECT * FROM soltrack_engine_sessions
      WHERE device_id = $1 AND engine_off_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [FLEET]
  );
  return result.rows[0] || null;
}

(async () => {
  try {
    await cleanup();
    await db.query(
      `INSERT INTO fleet_vehicles (fleet_number, registration_number, cost_center_id)
       VALUES ($1, $2, 25)`,
      [FLEET, REG]
    );
    identity.invalidate();

    assert.strictEqual(engine.parseEngineStatus('Engine On~No GPS signal 2 hours').engine, 'on');
    assert.strictEqual(engine.parseEngineStatus('Ignition Off').ignition, 'off');

    await status('Ignition On', at(0));
    const first = await openSession();
    assert(first, 'ignition start should open a session');
    const firstId = first.id;
    const firstOnAt = new Date(first.engine_on_at).getTime();

    await status('Ignition On', at(60));
    const repeated = await openSession();
    assert.strictEqual(repeated.id, firstId, 'repeated ignition on must not replace the session');
    assert.strictEqual(new Date(repeated.engine_on_at).getTime(), firstOnAt, 'repeated ignition on must not reset start');

    await evaluate(at(180, 5));
    const three = await db.query(
      `SELECT alarm_type FROM alert_groups WHERE device_id = $1 AND alarm_type ILIKE '%3h%'`,
      [FLEET]
    );
    assert(three.rows.length > 0, '3h threshold did not fire');

    await status('Engine Off', at(180, 10));
    const paused = await db.query(`SELECT * FROM soltrack_engine_sessions WHERE id = $1`, [firstId]);
    assert(paused.rows[0].engine_off_at, 'engine off should pause the session');
    assert(Number(paused.rows[0].accumulated_on_seconds) >= 10800, 'engine-on time should accumulate');

    await status('Ignition On', at(182));
    const resumed = await openSession();
    assert.strictEqual(resumed.id, firstId, 'short off gap should resume the same session');
    assert.strictEqual(new Date(resumed.engine_on_at).getTime(), firstOnAt, 'resume must not reset the counter');
    assert.strictEqual(resumed.fatigue_alerted_thresholds.includes('a43F6lFwgIUq_gkgmgSX08g'), true, 'held thresholds must survive a short gap');

    await evaluate(at(365, 5));
    const six = await db.query(
      `SELECT alarm_type FROM alert_groups WHERE device_id = $1 AND alarm_type ILIKE '%6h%'`,
      [FLEET]
    );
    assert(six.rows.length > 0, '6h threshold did not fire');

    await status('Engine Off', at(370));
    await status('Ignition On', at(376));
    const fresh = await openSession();
    assert(fresh, 'long off gap should open a new session');
    assert.notStrictEqual(fresh.id, firstId, 'long off gap should start a new session');
    assert.strictEqual(fresh.fatigue_alerted_thresholds, '[]', 'long off gap should clear held thresholds');

    const vs = await db.query(
      `SELECT engine_on, ignition_on FROM vehicle_status WHERE device_id = $1`,
      [FLEET]
    );
    assert.strictEqual(vs.rows[0].ignition_on, true, 'ignition state should be stored');
    assert.strictEqual(vs.rows[0].engine_on, false, 'engine state should be stored');

    console.log('SOLTRACK-ENGINE-LOCAL-OK');
  } catch (err) {
    console.error('SOLTRACK-ENGINE-LOCAL-FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await db.closePool();
  }
})();
