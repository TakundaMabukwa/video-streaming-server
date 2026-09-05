/**
 * Match an incoming event name/status against alert_definitions by NAME only.
 * No multicode/signal-code matching - the definition's `name` is the key.
 * Tries exact match first, then partial (substring) match.
 * @param {string} eventName
 * @param {Object} nameMap - { lowercase_name: { name, signalCode, severity } }
 * @returns {Object|null} matched definition entry or null
 */
function matchAlertDefinition(eventName, nameMap) {
  const eventLower = (eventName || '').trim().toLowerCase();
  if (!eventLower) return null;

  // 1. Exact match
  if (nameMap[eventLower]) return nameMap[eventLower];

  // 2. DB name is contained in event name (e.g. "driver fatigue" in "Driver Fatigue 3h (Low)")
  for (const [dbName, def] of Object.entries(nameMap)) {
    if (eventLower.includes(dbName)) return def;
  }

  // 3. Event name is contained in DB name
  for (const [dbName, def] of Object.entries(nameMap)) {
    if (dbName.includes(eventLower)) return def;
  }

  return null;
}

module.exports = { matchAlertDefinition };