/**
 * Match an incoming event name/status against alert_definitions by NAME first,
 * then by exact signal_code (rule id). This lets raw rule-id event types
 * (e.g. "RuleHarshBrakingId" or an unresolvable Geotab hash) still match a
 * definition. Names use exact then substring matching; signal codes are exact only.
 * @param {string} eventName
 * @param {Object} nameMap - { lowercase_name: { name, signalCode, severity } }
 * @param {Object} [signalCodeMap] - { lowercase_signal_code: { name, signalCode, severity } }
 * @returns {Object|null} matched definition entry or null
 */
function matchAlertDefinition(eventName, nameMap = {}, signalCodeMap = {}) {
  const eventLower = (eventName || '').trim().toLowerCase();
  if (!eventLower) return null;

  // 1. Exact name match
  if (nameMap[eventLower]) return nameMap[eventLower];

  // 2. Exact signal_code / rule-id match
  if (signalCodeMap[eventLower]) return signalCodeMap[eventLower];

  // 3. DB name is contained in event name (e.g. "driver fatigue" in "Driver Fatigue 3h (Low)")
  for (const [dbName, def] of Object.entries(nameMap)) {
    if (eventLower.includes(dbName)) return def;
  }

  // 4. Event name is contained in DB name
  for (const [dbName, def] of Object.entries(nameMap)) {
    if (dbName.includes(eventLower)) return def;
  }

  return null;
}

module.exports = { matchAlertDefinition };