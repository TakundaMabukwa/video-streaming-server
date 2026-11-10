const assert = require('assert');
const db = require('../src/db');
const identity = require('../src/vehicles/identity');
const engine = require('../src/services/soltrackEngineSessionService');

const FLEET = 'SOLTESTALL';
const CATCHUP_FLEET = 'SOLTESTCATCH';
const REG = 'TESTALL1';
const BASE = Date.now() + 7200000;

const EXPECTED = [
  { minutes: 180, name: 'Driver Fatigue 3h (Low)' },
  { minutes: 360, name: 'Driver Fatigue 6h (Medium)' },
  { minutes: 480, name: '8 Hour Duration Check' },
  { minutes: 540, name: 'Driver fatigue 9h (High)' },
  { minutes: 720, name: '12 Hour Duration Check' },
  { minutes: 900, name: '15 Hour Duration Check' },
];

function at(minutes = 0, seconds = 0) {
  return new Date(BASE + minutes * 60000 + seconds * 1000);
}

async function cleanupFleet(fleet) {
  await db.query(`DELETE FROM alert_combo_events WHERE device_id = $1`, [fleet]).catch(() => {});
  await db.query(`DELETE FROM alert_groups WHERE device_id = $1`, [fleet]).catch(() => {});
  await db.query(`DELETE FROM alerts WHERE device_id = $1`, [fleet]).catch(() => {});
  await db.query(`DELETE FROM telematics_events WHERE device_id = $1`, [fleet]).catch(() => {});
  await db.query(`DELETE FROM soltrack_engine_sessions WHERE device_id = $1`, [fleet]).catch(() => {});
  await db.query(`DELETE FROM vehicle_status WHERE device_id = $1`, [fleet]).catch(() => {});
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number = $1`, [fleet]).catch(() => {});
}

async function cleanup() {
  await cleanupFleet(FLEET);
  await cleanupFleet(CATCHUP_FLEET);
}

async function setupFleet(fleet, reg) {
  await db.query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, cost_center_id)
     VALUES ($1, $2, 25)`,
    [fleet, reg]
  );
}

async function status(fleet, reg, text, when) {
  return engine.handleEngineStatus({
    fleetNumber: fleet,
    registration: reg,
    costCenterId: 25,
    status: text,
    eventTime: when,
    speed: 0,
    lat: -26.1,
    lon: 28.2,
  });
}

async function evaluate(fleet, reg, when) {
  return engine.evaluateEngineThresholds({
    fleetNumber: fleet,
    registration: reg,
    lat: -26.1,
    lon: 28.2,
    speed: 0,
    eventTime: when,
  });
}

async function alertTypes(fleet) {
  const result = await db.query(
    `SELECT DISTINCT alarm_type FROM alert_groups WHERE device_id = $1 ORDER BY alarm_type`,
    [fleet]
  );
  return result.rows.map((row) => row.alarm_type);
}

(async () => {
  try {
    await cleanup();
    await setupFleet(FLEET, REG);
    await setupFleet(CATCHUP_FLEET, 'TESTCATCH1');
    identity.invalidate();

    await status(FLEET, REG, 'Ignition On', at(0));

    for (const threshold of EXPECTED) {
      await status(FLEET, REG, 'Ignition On', at(threshold.minutes, 1));
      await evaluate(FLEET, REG, at(threshold.minutes, 5));
    }

    const fired = await alertTypes(FLEET);
    for (const threshold of EXPECTED) {
      assert(fired.includes(threshold.name), `missing ${threshold.name}; got ${fired.join(', ')}`);
    }
    assert.strictEqual(fired.length, EXPECTED.length, `expected only the 6 thresholds, got ${fired.join(', ')}`);

    await status(CATCHUP_FLEET, 'TESTCATCH1', 'Engine On', at(0));
    await evaluate(CATCHUP_FLEET, 'TESTCATCH1', at(900, 5));
    const catchup = await alertTypes(CATCHUP_FLEET);
    assert.deepStrictEqual(catchup, ['15 Hour Duration Check'], `catch-up should fire only 15h, got ${catchup.join(', ')}`);

    const catchupSession = await db.query(
      `SELECT fatigue_alerted_thresholds FROM soltrack_engine_sessions
        WHERE device_id = $1 AND engine_off_at IS NULL ORDER BY id DESC LIMIT 1`,
      [CATCHUP_FLEET]
    );
    const held = JSON.parse(catchupSession.rows[0].fatigue_alerted_thresholds);
    assert.strictEqual(held.length, 6, `expected all 6 thresholds held after catch-up, got ${held.length}`);

    console.log('SOLTRACK-ENGINE-ALL-THRESHOLDS-OK');
  } catch (err) {
    console.error('SOLTRACK-ENGINE-ALL-THRESHOLDS-FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await db.closePool();
  }
})();
