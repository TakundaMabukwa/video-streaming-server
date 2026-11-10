const assert = require('assert');
const db = require('../src/db');
const identity = require('../src/vehicles/identity');
const zoneNotifications = require('../src/services/zoneNotifications');
const zoneService = require('../src/services/soltrackZoneService');
const soltrack = require('../src/services/soltrackClient');

const FLEET = 'SOLTEST1';
const REG = 'TESTREG1';

const zones = [
  {
    id: 'soltest-hr',
    name: 'SOLTEST High Risk',
    x: 28.2,
    isHighRisk: true,
    isNoGo: false,
    isNoStopping: false,
    category: 'high_risk',
  },
  {
    id: 'soltest-ng',
    name: 'SOLTEST No Go',
    x: 28.21,
    isHighRisk: false,
    isNoGo: true,
    isNoStopping: false,
    category: 'no_go',
  },
  {
    id: 'soltest-ns',
    name: 'SOLTEST No Stopping',
    x: 28.22,
    isHighRisk: false,
    isNoGo: false,
    isNoStopping: true,
    category: 'no_stopping',
  },
];

function pointsFor(x) {
  return JSON.stringify([
    { x: x - 0.0005, y: -26.1005 },
    { x: x + 0.0005, y: -26.1005 },
    { x: x + 0.0005, y: -26.0995 },
    { x: x - 0.0005, y: -26.0995 },
    { x: x - 0.0005, y: -26.1005 },
  ]);
}

async function cleanup() {
  await db.query(`DELETE FROM alert_combo_events WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM alert_groups WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM alerts WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM telematics_events WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM high_risk_zone_entries WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM zone_stop_events WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM telemetry_history WHERE device_id = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM fleet_vehicles WHERE fleet_number = $1`, [FLEET]).catch(() => {});
  await db.query(`DELETE FROM geotab_zones WHERE id LIKE 'soltest-%'`).catch(() => {});
}

async function setup() {
  await cleanup();
  await db.query(
    `INSERT INTO fleet_vehicles (fleet_number, registration_number, cost_center_id)
     VALUES ($1, $2, 25)`,
    [FLEET, REG]
  );

  for (const zone of zones) {
    await db.query(
      `INSERT INTO geotab_zones
         (id, name, points, is_high_risk, is_no_go, is_no_stopping, zone_category)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [zone.id, zone.name, pointsFor(zone.x), zone.isHighRisk, zone.isNoGo, zone.isNoStopping, zone.category]
    );
  }

  identity.invalidate();
  zoneService.invalidateZonesCache();
}

function at(base, seconds) {
  return new Date(base + seconds * 1000);
}

async function check(secondsFromBase, lat, lon, speed) {
  await zoneService.checkVehicleZones({
    fleetNumber: FLEET,
    registration: REG,
    lat,
    lon,
    speed,
    eventTime: at(base, secondsFromBase),
  });
}

let base = 0;

(async () => {
  try {
    await setup();
    base = Date.now() + 60000;

    await check(0, -26.1030, 28.2000, 60);
    await check(15, -26.1020, 28.2000, 60);

    let notes = zoneNotifications.snapshot().filter((n) => n.fleet_number === FLEET);
    assert(notes.some((n) => n.kind === 'approaching' && n.zone_id === 'soltest-hr'), 'high-risk approach notification missing');

    await check(30, -26.1000, 28.2000, 30);
    notes = zoneNotifications.snapshot().filter((n) => n.fleet_number === FLEET);
    assert(notes.some((n) => n.kind === 'entering' && n.alert_type === 'Entering High Risk Area'), 'high-risk entry notification missing');

    await check(45, -26.1000, 28.2000, 0);
    const stops = await db.getActiveZoneStopEvents(FLEET);
    assert(stops.some((s) => s.zone_id === 'soltest-hr'), 'high-risk stop event missing');
    const groups = await db.query(
      `SELECT alarm_type FROM alert_groups WHERE device_id = $1 ORDER BY id`,
      [FLEET]
    );
    assert(groups.rows.some((g) => g.alarm_type === 'Stopped High Risk area'), 'immediate stop alert missing');

    await check(60, -26.1030, 28.2000, 30);
    const openEntries = await db.getActiveZoneEntries(FLEET);
    assert(!openEntries.some((e) => e.zone_id === 'soltest-hr'), 'high-risk exit did not close');

    await check(75, -26.1030, 28.2100, 60);
    await check(90, -26.1000, 28.2100, 30);
    notes = zoneNotifications.snapshot().filter((n) => n.fleet_number === FLEET);
    assert(notes.some((n) => n.kind === 'entering' && /no-go/i.test(n.alert_type || '')), 'no-go entry notification missing');
    assert(!notes.some((n) => n.kind === 'approaching' && n.zone_id === 'soltest-ng'), 'no-go must not approach');

    await check(105, -26.1030, 28.2200, 60);
    await check(120, -26.1000, 28.2200, 30);
    notes = zoneNotifications.snapshot().filter((n) => n.fleet_number === FLEET);
    assert(notes.some((n) => n.kind === 'entering' && n.alert_type === 'Entering No Stopping Zone'), 'no-stopping entry notification missing');
    assert(!notes.some((n) => n.kind === 'approaching' && n.zone_id === 'soltest-ns'), 'no-stopping must not approach');

    await check(135, -26.1000, 28.2200, 0);
    const noStoppingStops = await db.getActiveZoneStopEvents(FLEET);
    assert(
      noStoppingStops.some((s) => s.zone_id === 'soltest-ns' && s.zone_type === 'no_stopping'),
      'no-stopping stop event missing'
    );

    await soltrack.refreshFleetDict();
    await soltrack.handleFrame({
      reg: REG,
      speed: 20,
      lat: -26.1030,
      lon: 28.3000,
      locTime: new Date(base + 150000).toISOString(),
      status: '',
      geoZone: '',
      driver: '',
    });
    await soltrack.handleFrame({
      reg: REG,
      speed: 21,
      lat: -26.1029,
      lon: 28.3001,
      locTime: new Date(base + 151000).toISOString(),
      status: '',
      geoZone: '',
      driver: '',
    });
    await soltrack.flushTelemetryHistory();

    const history = await db.query(
      `SELECT count(*)::int AS count FROM telemetry_history WHERE device_id = $1`,
      [FLEET]
    );
    assert.strictEqual(history.rows[0].count, 2, `expected 2 history rows, got ${history.rows[0].count}`);

    console.log('SOLTRACK-ZONE-LOCAL-OK');
  } catch (err) {
    console.error('SOLTRACK-ZONE-LOCAL-FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await db.closePool();
  }
})();
