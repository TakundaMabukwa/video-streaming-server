// Transient zone notifications.
//
// These are intentionally NOT alerts: nothing is written to alert_groups,
// incidents, NCRs or reports. They live in memory, stream over SSE and expire
// when the approach/entry condition is no longer true.
const APPROACH_TTL_MS = 60 * 1000;
const ENTRY_TTL_MS = 30 * 60 * 1000;
const SIGNAL_LOSS_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 5000;

const notifications = new Map();
let broadcastFn = null;
let timer = null;

function setBroadcast(fn) {
  broadcastFn = typeof fn === 'function' ? fn : null;
}

function keyOf({ fleet_number, kind, zone_id, zone_name, alert_type }) {
  const fleet = String(fleet_number || '').trim().toUpperCase();
  const zone = String(zone_id || zone_name || alert_type || '').trim().toUpperCase();
  return `${fleet}|${kind}|${zone}`;
}

function emit(event) {
  if (broadcastFn) {
    Promise.resolve(broadcastFn(event)).catch(() => {});
  }
}

function upsert(input = {}) {
  const kind = input.kind === 'approaching' ? 'approaching' : input.kind === 'signal_loss' ? 'signal_loss' : 'entering';
  const fleet = String(input.fleet_number || '').trim().toUpperCase();
  if (!fleet) return null;
  const now = Date.now();
  const key = keyOf({ ...input, fleet_number: fleet, kind });
  const existing = notifications.get(key);
  const ttl = kind === 'approaching' ? APPROACH_TTL_MS : kind === 'signal_loss' ? SIGNAL_LOSS_TTL_MS : ENTRY_TTL_MS;
  const notification = {
    id: key,
    fleet_number: fleet,
    device_id: input.device_id || existing?.device_id || null,
    plate: input.plate || existing?.plate || null,
    cost_center_id: input.cost_center_id ?? existing?.cost_center_id ?? null,
    kind,
    alert_type: input.alert_type || existing?.alert_type || 'Zone notification',
    zone_id: input.zone_id == null ? existing?.zone_id ?? null : String(input.zone_id),
    zone_name: input.zone_name || existing?.zone_name || null,
    severity: String(input.severity || existing?.severity || 'medium').toLowerCase(),
    eta_seconds: input.eta_seconds == null ? existing?.eta_seconds ?? null : Number(input.eta_seconds),
    distance_meters: input.distance_meters == null ? existing?.distance_meters ?? null : Number(input.distance_meters),
    speed: input.speed == null ? existing?.speed ?? null : Number(input.speed),
    lat: input.lat == null ? existing?.lat ?? null : Number(input.lat),
    lon: input.lon == null ? existing?.lon ?? null : Number(input.lon),
    created_at: existing?.created_at || now,
    updated_at: now,
    expires_at: now + ttl,
  };
  notifications.set(key, notification);
  emit({ type: 'ZONE_NOTIFICATION_UPSERT', fleet_number: fleet, notification });
  return notification;
}

function remove(id, reason = 'ended') {
  const key = String(id || '').trim();
  const existing = notifications.get(key);
  if (!existing) return false;
  notifications.delete(key);
  emit({ type: 'ZONE_NOTIFICATION_REMOVE', fleet_number: existing.fleet_number, id: key, reason });
  return true;
}

function removeMatching(predicate, reason = 'ended') {
  for (const notification of [...notifications.values()]) {
    if (predicate(notification)) remove(notification.id, reason);
  }
}

function removeApproach(fleetNumber, zoneId) {
  const fleet = String(fleetNumber || '').trim().toUpperCase();
  const zone = String(zoneId || '').trim();
  if (!fleet || !zone) return;
  removeMatching((n) => n.kind === 'approaching' && n.fleet_number === fleet && String(n.zone_id || '') === zone, 'entered');
}

function removeEntry(fleetNumber, zoneId) {
  const fleet = String(fleetNumber || '').trim().toUpperCase();
  const zone = String(zoneId || '').trim();
  if (!fleet || !zone) return;
  removeMatching((n) => n.kind === 'entering' && n.fleet_number === fleet && String(n.zone_id || '') === zone, 'exited');
}

function sweep() {
  const now = Date.now();
  for (const notification of [...notifications.values()]) {
    if (notification.expires_at != null && notification.expires_at <= now) {
      remove(notification.id, 'expired');
    }
  }
}

function snapshot() {
  return [...notifications.values()];
}

function start() {
  if (timer) return;
  timer = setInterval(sweep, SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  setBroadcast,
  upsert,
  remove,
  removeApproach,
  removeEntry,
  removeMatching,
  sweep,
  snapshot,
  start,
  stop,
};
