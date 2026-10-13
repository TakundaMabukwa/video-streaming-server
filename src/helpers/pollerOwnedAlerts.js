/**
 * Single source of truth for telematics alert types whose alert_groups are
 * created ONLY by the DeviceStatusInfo poller (deviceStatusPoller.js).
 *
 * The Geotab exception-event feed still archives these events to
 * telematics_events (for later comparison with what our detection produced)
 * but must NOT create alert_groups / new-alert broadcasts for them.
 *
 * Both the feed gate (geotabPolling.js) and the poller import these so the
 * two sides can never drift apart.
 */

// ── Signal codes used by the poller to emit alerts ──
const FATIGUE_3H_CODE = 'a43F6lFwgIUq_gkgmgSX08g'; // Driver Fatigue 3h (Low)
const FATIGUE_6H_CODE = 'aScBH27NHXUqTLcl8QcCo4g'; // Driver Fatigue 6h (Medium)
const FATIGUE_9H_CODE = 'adT7lgnAOhEep8a1M4u09eg'; // Driver fatigue 9h (High)
const DURATION_8H_CODE = 'aXmPcWqFx3kKp1XKdQDQEYQ'; // 8 Hour Duration Check
const DURATION_12H_CODE = 'aJ2f9avKM80Ch7JgyCqOl7A'; // 12 Hour Duration Check
const DURATION_15H_CODE = 'aTZcSSADJ60eeqxk2DNGkZA'; // 15 Hour Duration Check
const SPEED_85_CODE = 'aURw7fNBdxEGWY3NXil_yIg'; // Heavy Duty Max Speeding 85km/h
const SPEED_90_CODE = 'aLv1Bv53LBkClq5rSQ5QPkQ'; // Heavy Duty Max Speeding 90KM/H
const ZONE_ENTRY_CODE = 'aCmnsH92P1kqGBTWyRmdacA'; // Entering High Risk Area
const NOGO_ENTRY_CODE = 'nsg-enter-nogo-01'; // Entering No-Go Zone
const NO_STOP_ENTRY_CODE = 'nsg-enter-nostop-01'; // Entering No Stopping Zone
const ZONE_APPROACHING_CODE = 'zone-approaching'; // Approaching Zone (predictive)
const ZONE_STOP_IMMEDIATE_CODE = 'aKW3NJEDtS0OpMwwVlTHWJQ'; // Stopped High Risk area
const ZONE_STOP_1MIN_HIGH_CODE = 'aCOAc4GcoSkKgsIS9Qnb7mA'; // Stopped > 1min High Risk
const ZONE_STOP_1MIN_NO_CODE = 'aUg2ERYlb3UChMJWTat0fKw'; // Stopped > 1min No Stopping

// ── Definition names owned by the poller (lowercased for matching). ──
// Matching on name is essential: the duplicate "15 Hour Duration Check" def
// carries an empty signal_code, so a code-only gate could miss it depending on
// which duplicate row wins the name map.
const POLLER_OWNED_ALARM_NAMES = new Set([
  'heavy duty max speeding 85km/h',
  'heavy duty max speeding 90km/h',
  'entering high risk area',
  'entering no-go zone',
  'entering no stopping zone',
  'stopped high risk area',
  'stopped > 1min high risk',
  'stopped > 1min no stopping',
  'approaching zone',
  'driver fatigue 3h (low)',
  'driver fatigue 6h (medium)',
  'driver fatigue 9h (high)',
  '8 hour duration check',
  '12 hour duration check',
  '15 hour duration check',
]);

const POLLER_OWNED_SIGNAL_CODES = new Set([
  FATIGUE_3H_CODE,
  FATIGUE_6H_CODE,
  FATIGUE_9H_CODE,
  DURATION_8H_CODE,
  DURATION_12H_CODE,
  DURATION_15H_CODE,
  SPEED_85_CODE,
  SPEED_90_CODE,
  ZONE_ENTRY_CODE,
  NOGO_ENTRY_CODE,
  NO_STOP_ENTRY_CODE,
  ZONE_APPROACHING_CODE,
  ZONE_STOP_IMMEDIATE_CODE,
  ZONE_STOP_1MIN_HIGH_CODE,
  ZONE_STOP_1MIN_NO_CODE,
].map((c) => c.toLowerCase()));

/**
 * True when a matched telematics definition is owned by the poller
 * (feed must store the event but skip alert_group creation).
 * @param {{name?: string, signalCode?: string}|null} def
 * @returns {boolean}
 */
function isPollerOwnedAlert(def) {
  if (!def) return false;
  if (POLLER_OWNED_ALARM_NAMES.has(String(def.name || '').trim().toLowerCase())) return true;
  if (POLLER_OWNED_SIGNAL_CODES.has(String(def.signalCode || '').trim().toLowerCase())) return true;
  return false;
}

module.exports = {
  isPollerOwnedAlert,
  POLLER_OWNED_ALARM_NAMES,
  POLLER_OWNED_SIGNAL_CODES,
  FATIGUE_3H_CODE,
  FATIGUE_6H_CODE,
  FATIGUE_9H_CODE,
  DURATION_8H_CODE,
  DURATION_12H_CODE,
  DURATION_15H_CODE,
  SPEED_85_CODE,
  SPEED_90_CODE,
  ZONE_ENTRY_CODE,
  NOGO_ENTRY_CODE,
  NO_STOP_ENTRY_CODE,
  ZONE_APPROACHING_CODE,
  ZONE_STOP_IMMEDIATE_CODE,
  ZONE_STOP_1MIN_HIGH_CODE,
  ZONE_STOP_1MIN_NO_CODE,
};