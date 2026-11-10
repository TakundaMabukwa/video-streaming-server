const turf = require('@turf/turf');
const db = require('../db');
const zoneNotifications = require('./zoneNotifications');
const { emitDeviceStatusAlert } = require('./deviceStatusPoller');
const { categoryOf, entryLabel, riskLevel } = require('../alerts/zoneCategory');
const { ZONE_APPROACHING_CODE, ZONE_STOP_IMMEDIATE_CODE } = require('../helpers/pollerOwnedAlerts');

const ZONES_CACHE_TTL_MS = 5 * 60 * 1000;
const STOP_SPEED = 5;
const STOP_SPEED_NO_STOPPING = 10;
const APPROACH_SECONDS = 45;
const MIN_PENETRATION_KM = 0.03;
const MAX_FLEET_STATES = 5000;

let zonesState = { data: null, ts: 0 };
const fleetStates = new Map();
const inFlight = new Set();

function validCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function invalidateZonesCache() {
  zonesState = { data: null, ts: 0 };
}

async function getZones() {
  if (zonesState.data && Date.now() - zonesState.ts < ZONES_CACHE_TTL_MS) return zonesState.data;

  const rows = await db.getHighRiskZones();
  const built = [];
  for (const zone of rows) {
    let points = zone.points;
    if (typeof points === 'string') {
      try { points = JSON.parse(points); } catch { continue; }
    }
    if (!Array.isArray(points) || points.length < 3) continue;

    const ring = [];
    for (const point of points) {
      const lng = Number(point?.x);
      const lat = Number(point?.y);
      if (!validCoord(lat, lng)) { ring.length = 0; break; }
      ring.push([lng, lat]);
    }
    if (ring.length < 3) continue;

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);

    try {
      built.push({
        id: String(zone.id),
        name: zone.name,
        is_high_risk: !!zone.is_high_risk,
        is_no_go: !!zone.is_no_go,
        is_no_stopping: !!zone.is_no_stopping,
        zone_category: zone.zone_category || null,
        polygon: turf.cleanCoords(turf.polygon([ring])),
      });
    } catch {}
  }

  zonesState = { data: built, ts: Date.now() };
  return built;
}

async function ensureFleetState(fleetNumber) {
  let state = fleetStates.get(fleetNumber);
  if (!state) {
    state = {
      prevLat: null,
      prevLon: null,
      prevTime: null,
      entries: new Set(),
      stops: new Map(),
      initialized: false,
      lastSeen: 0,
    };
    fleetStates.set(fleetNumber, state);
  }

  if (!state.initialized) {
    const [entries, stops] = await Promise.all([
      db.getActiveZoneEntries(fleetNumber).catch(() => []),
      db.getActiveZoneStopEvents(fleetNumber).catch(() => []),
    ]);
    state.entries = new Set((entries || []).map((entry) => String(entry.zone_id)));
    state.stops = new Map((stops || []).map((stop) => [String(stop.zone_id), stop]));
    state.initialized = true;
  }

  state.lastSeen = Date.now();
  if (fleetStates.size > MAX_FLEET_STATES) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, value] of fleetStates) {
      if (value.lastSeen < cutoff) fleetStates.delete(key);
    }
  }
  return state;
}

function emitZone({ fleetNumber, registration, lat, lon, speed, eventTime, signalCode, alarmText, extra }) {
  return emitDeviceStatusAlert({
    deviceId: fleetNumber,
    fleetNumber,
    licensePlate: registration || null,
    signalCode,
    alarmText,
    lat,
    lon,
    speed,
    ts: eventTime,
    extra,
  });
}

async function processZones({ fleetNumber, registration, lat, lon, speed, eventTime, state, zones }) {
  const nowTs = eventTime.toISOString();
  const currentZoneIds = [];
  const insideZones = [];
  const crossedZones = [];
  const wasInside = state.entries;
  const hasPrev = state.prevLat != null && state.prevLon != null;
  const pathLine = hasPrev
    ? turf.lineString([[state.prevLon, state.prevLat], [lon, lat]])
    : null;

  for (const zone of zones) {
    const zoneId = String(zone.id);
    let inside = false;
    let crossed = false;
    try {
      inside = turf.booleanPointInPolygon(turf.point([lon, lat]), zone.polygon);
      if (pathLine) crossed = turf.lineIntersect(pathLine, zone.polygon).features.length > 0;
    } catch {
      continue;
    }

    if (inside) {
      currentZoneIds.push(zoneId);
      insideZones.push(zone);
    } else if (crossed && !wasInside.has(zoneId)) {
      crossedZones.push(zone);
    }
  }

  if (hasPrev) {
    const previous = turf.point([state.prevLon, state.prevLat]);
    const current = turf.point([lon, lat]);
    let bearing = 0;
    try { bearing = turf.bearing(previous, current); } catch { bearing = 0; }

    const speedKmPerSecond = Math.max(Number(speed) || 0, 1) / 3600;
    let predicted = current;
    try {
      predicted = turf.destination(current, speedKmPerSecond * APPROACH_SECONDS, bearing, { units: 'kilometers' });
    } catch { predicted = current; }

    const trajectory = turf.lineString([
      current.geometry.coordinates,
      predicted.geometry.coordinates,
    ]);

    for (const zone of zones) {
      const zoneId = String(zone.id);
      if (insideZones.some((item) => String(item.id) === zoneId)) continue;
      if (wasInside.has(zoneId)) continue;
      if (categoryOf(zone) !== 'high_risk') continue;

      try {
        const intersections = turf.lineIntersect(trajectory, zone.polygon);
        if (intersections.features.length < 2) continue;

        const entryPoint = intersections.features[0];
        const exitPoint = intersections.features[1];
        const penetrationKm = turf.distance(entryPoint, exitPoint, { units: 'kilometers' });
        if (penetrationKm < MIN_PENETRATION_KM) continue;

        const distanceToEntry = turf.distance(current, entryPoint, { units: 'kilometers' });
        const etaSeconds = Number(speed) > 0 ? distanceToEntry / (Number(speed) / 3600) : Infinity;
        if (!Number.isFinite(etaSeconds) || etaSeconds > APPROACH_SECONDS) continue;

        await emitZone({
          fleetNumber,
          registration,
          lat,
          lon,
          speed,
          eventTime,
          signalCode: ZONE_APPROACHING_CODE,
          alarmText: `Approaching High Risk Zone: ${zone.name} (ETA ~${Math.round(etaSeconds)}s)`,
          extra: {
            zoneId,
            zoneName: zone.name,
            zoneType: 'high_risk',
            etaSeconds: Math.round(etaSeconds),
            distanceMeters: Math.round(distanceToEntry * 1000),
            penetrationMeters: Math.round(penetrationKm * 1000),
            bearing: bearing.toFixed(1),
          },
        });
      } catch {}
    }
  }

  for (const zoneId of [...wasInside]) {
    if (currentZoneIds.includes(zoneId)) continue;
    try {
      await db.query(
        `UPDATE high_risk_zone_entries SET is_active = FALSE, exit_time = $2
          WHERE device_id = $1 AND zone_id = $3 AND is_active = TRUE`,
        [fleetNumber, nowTs, zoneId]
      );
    } catch (err) {
      console.error(`[SOLTRACK-ZONE] exit close failed fleet=${fleetNumber} zone=${zoneId}: ${err.message}`);
    }
    state.entries.delete(zoneId);
    zoneNotifications.removeEntry(fleetNumber, zoneId);

    const stop = state.stops.get(zoneId);
    if (stop) {
      await db.endZoneStopEvent(stop.id, nowTs).catch(() => {});
      state.stops.delete(zoneId);
    }
  }

  for (const zone of [...insideZones, ...crossedZones]) {
    const zoneId = String(zone.id);
    if (state.entries.has(zoneId)) continue;

    const zoneType = zone.is_no_go ? 'no_go' : zone.is_no_stopping ? 'no_stopping' : 'high_risk';
    const label = entryLabel(zoneType);
    if (!label) continue;

    const entry = await db.insertZoneEntry({
      deviceId: fleetNumber,
      fleetNumber,
      licensePlate: registration || null,
      zoneId,
      zoneName: zone.name,
      riskLevel: riskLevel(zoneType),
      latitude: lat,
      longitude: lon,
      speed: speed ?? null,
      entryTime: nowTs,
    }).catch(() => null);

    state.entries.add(zoneId);
    if (!entry) continue;

    await emitZone({
      fleetNumber,
      registration,
      lat,
      lon,
      speed,
      eventTime,
      signalCode: label.code,
      alarmText: `Entering ${label.text} in zone ${zone.name}`,
      extra: { zoneId, zoneName: zone.name, zoneType },
    });
  }

  for (const zone of insideZones) {
    const zoneId = String(zone.id);
    const zoneType = categoryOf(zone);
    if (zoneType === 'normal') continue;

    const threshold = zoneType === 'no_stopping' ? STOP_SPEED_NO_STOPPING : STOP_SPEED;
    const stopped = Number(speed) < threshold;
    let stop = state.stops.get(zoneId);

    if (stopped) {
      if (!stop) {
        stop = await db.startZoneStopEvent({
          deviceId: fleetNumber,
          fleetNumber,
          licensePlate: registration || null,
          zoneId,
          zoneName: zone.name,
          zoneType,
          stoppedAt: nowTs,
        }).catch(() => null);
        if (stop) state.stops.set(zoneId, stop);
      }
      if (!stop) continue;

      if (!stop.immediate_alert_sent) {
        const sent = await emitZone({
          fleetNumber,
          registration,
          lat,
          lon,
          speed,
          eventTime,
          signalCode: ZONE_STOP_IMMEDIATE_CODE,
          alarmText: `Stopped ${zoneType === 'no_stopping' ? 'No Stopping zone' : 'High Risk area'} in ${zone.name}`,
          extra: { zoneName: zone.name },
        });
        if (sent) {
          await db.markZoneStopAlertSent(stop.id, 'immediate').catch(() => {});
          stop.immediate_alert_sent = true;
        }
      }
    } else if (stop) {
      await db.endZoneStopEvent(stop.id, nowTs).catch(() => {});
      state.stops.delete(zoneId);
    }
  }

  for (const [zoneId, stop] of [...state.stops]) {
    if (currentZoneIds.includes(zoneId)) continue;
    await db.endZoneStopEvent(stop.id, nowTs).catch(() => {});
    state.stops.delete(zoneId);
  }
}

async function checkVehicleZones({ fleetNumber, registration = null, lat, lon, speed = 0, eventTime }) {
  const fleet = String(fleetNumber || '').trim();
  const latNumber = Number(lat);
  const lonNumber = Number(lon);
  if (!fleet || !validCoord(latNumber, lonNumber)) return;
  if (inFlight.has(fleet)) return;

  inFlight.add(fleet);
  try {
    const when = eventTime ? new Date(eventTime) : new Date();
    if (Number.isNaN(when.getTime())) return;

    const state = await ensureFleetState(fleet);
    if (state.prevLat == null || state.prevLon == null) {
      state.prevLat = latNumber;
      state.prevLon = lonNumber;
      state.prevTime = when.getTime();
      return;
    }
    if (when.getTime() < state.prevTime) return;

    const zones = await getZones();
    await processZones({
      fleetNumber: fleet,
      registration,
      lat: latNumber,
      lon: lonNumber,
      speed: Number(speed) || 0,
      eventTime: when,
      state,
      zones,
    });

    state.prevLat = latNumber;
    state.prevLon = lonNumber;
    state.prevTime = when.getTime();
  } catch (err) {
    console.error('[SOLTRACK-ZONE] check failed:', err.message);
  } finally {
    inFlight.delete(fleet);
  }
}

module.exports = {
  checkVehicleZones,
  invalidateZonesCache,
};
