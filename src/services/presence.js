// In-memory registry tracking which users are currently viewing which alert.
// Both the WebSocket server (to join/leave on active/inactive) and an HTTP
// endpoint (to query "who is viewing this alert?" on open) use this module.

const viewersByAlert = new Map(); // alertId -> Set<userEmail>

function joinAlert(alertId, user) {
  if (!alertId || !user) return false;
  if (!viewersByAlert.has(alertId)) {
    viewersByAlert.set(alertId, new Set());
  }
  viewersByAlert.get(alertId).add(user);
  return true;
}

function leaveAlert(alertId, user) {
  if (!alertId || !user) return false;
  const set = viewersByAlert.get(alertId);
  if (set) {
    set.delete(user);
    if (set.size === 0) {
      viewersByAlert.delete(alertId);
    }
  }
  return true;
}

function getViewers(alertId) {
  const set = viewersByAlert.get(alertId);
  if (!set) return [];
  return Array.from(set).filter(Boolean);
}

function getViewersExcept(alertId, user) {
  return getViewers(alertId).filter((u) => u !== user);
}

function count() {
  return viewersByAlert.size;
}

module.exports = { joinAlert, leaveAlert, getViewers, getViewersExcept, count };
