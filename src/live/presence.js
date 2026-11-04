// In-memory live presence for a single instance. Two scopes are tracked:
//   fleet  -> who is reviewing that vehicle/incident
//   alert  -> who is reviewing that exact alert group
// Heartbeats expire after 90 seconds; explicit LEAVE removes immediately.

const TTL_MS = 90 * 1000;

const byFleet = new Map(); // fleet -> Map<user, timestamp>
const byAlert = new Map(); // alertGroupId -> Map<user, timestamp>

function norm(v) {
  return String(v == null ? '' : v).trim();
}

function add(map, key, user, now) {
  if (!key || !user) return;
  if (!map.has(key)) map.set(key, new Map());
  map.get(key).set(user, now);
}

function remove(map, key, user) {
  if (!key) return;
  const set = map.get(key);
  if (!set) return;
  if (user) set.delete(user);
  else set.clear();
  if (set.size === 0) map.delete(key);
}

function sweep(now = Date.now()) {
  for (const map of [byFleet, byAlert]) {
    for (const [key, users] of map) {
      for (const [user, ts] of users) {
        if (!Number.isFinite(ts) || now - ts > TTL_MS) users.delete(user);
      }
      if (users.size === 0) map.delete(key);
    }
  }
}

function heartbeat({ fleetNumber, alertGroupId, user, action = 'ENTER' }) {
  const fleet = norm(fleetNumber).toUpperCase();
  const alert = norm(alertGroupId);
  const who = norm(user);
  if (!who) return null;
  const now = Date.now();
  sweep(now);

  if (String(action).toUpperCase() === 'LEAVE') {
    remove(byFleet, fleet, who);
    remove(byAlert, alert, who);
  } else {
    add(byFleet, fleet, who, now);
    add(byAlert, alert, who, now);
  }

  return {
    type: 'PRESENCE_UPDATE',
    fleet_number: fleet || null,
    alert_group_id: alert || null,
    viewing_user: String(action).toUpperCase() === 'LEAVE' ? null : who,
    action: String(action).toUpperCase() === 'LEAVE' ? 'LEAVE' : 'ENTER',
  };
}

function usersOf(map, key) {
  sweep();
  const set = map.get(norm(key));
  return set ? Array.from(set.keys()) : [];
}

function viewersForFleet(fleetNumber) {
  return usersOf(byFleet, norm(fleetNumber).toUpperCase());
}

function viewersForAlert(alertGroupId) {
  return usersOf(byAlert, norm(alertGroupId));
}

function snapshot() {
  sweep();
  const fleets = {};
  const alerts = {};
  for (const [key, users] of byFleet) if (users.size) fleets[key] = Array.from(users.keys());
  for (const [key, users] of byAlert) if (users.size) alerts[key] = Array.from(users.keys());
  return { fleets, alerts };
}

module.exports = {
  heartbeat,
  sweep,
  viewersForFleet,
  viewersForAlert,
  snapshot,
  TTL_MS,
};
