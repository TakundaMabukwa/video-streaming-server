/**
 * Match an incoming event against alert_definitions by EXACT name or EXACT
 * signal_code only. No substring/fuzzy matching — an event is never relabeled
 * to a definition it doesn't exactly match.
 * @param {string} eventName - resolved rule name (e.g. "Harsh Braking")
 * @param {Object} nameMap - { lowercase_name: { name, signalCode, severity } }
 * @param {Object} [signalCodeMap] - { lowercase_signal_code: { name, signalCode, severity } }
 * @param {string} [eventCode] - raw rule id / signal code (e.g. "RuleHarshBrakingId")
 * @returns {Object|null} matched definition entry or null
 */
function matchAlertDefinition(eventName, nameMap = {}, signalCodeMap = {}, eventCode = '') {
  const eventLower = (eventName || '').trim().toLowerCase();
  if (!eventLower) return null;

  // 1. Exact name match
  if (nameMap[eventLower]) return nameMap[eventLower];

  // 2. Exact signal_code / rule-id match (event name may itself be an unresolved id)
  if (signalCodeMap[eventLower]) return signalCodeMap[eventLower];

  // 3. Exact eventCode (rule id) match against definition signal_code
  const codeLower = (eventCode || '').trim().toLowerCase();
  if (codeLower && signalCodeMap[codeLower]) return signalCodeMap[codeLower];

  return null;
}

module.exports = { matchAlertDefinition };
