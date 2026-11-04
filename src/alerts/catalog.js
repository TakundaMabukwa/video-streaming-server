// Single source of truth for alert identity: signal codes, names, ownership and
// source policy. No other module should hardcode these strings.

const FATIGUE_3H_CODE = 'a43F6lFwgIUq_gkgmgSX08g';
const FATIGUE_6H_CODE = 'aScBH27NHXUqTLcl8QcCo4g';
const FATIGUE_9H_CODE = 'adT7lgnAOhEep8a1M4u09eg';
const DURATION_8H_CODE = 'aXmPcWqFx3kKp1XKdQDQEYQ';
const DURATION_12H_CODE = 'aJ2f9avKM80Ch7JgyCqOl7A';
const DURATION_15H_CODE = 'aTZcSSADJ60eeqxk2DNGkZA';
const SPEED_85_CODE = 'aURw7fNBdxEGWY3NXil_yIg';
const SPEED_90_CODE = 'aLv1Bv53LBkClq5rSQ5QPkQ';
const ZONE_ENTRY_CODE = 'aCmnsH92P1kqGBTWyRmdacA';
const NOGO_ENTRY_CODE = 'nsg-enter-nogo-01';
const NO_STOP_ENTRY_CODE = 'nsg-enter-nostop-01';
const ZONE_APPROACHING_CODE = 'zone-approaching';
const ZONE_STOP_IMMEDIATE_CODE = 'aKW3NJEDtS0OpMwwVlTHWJQ';
const ZONE_STOP_1MIN_HIGH_CODE = 'aCOAc4GcoSkKgsIS9Qnb7mA';
const ZONE_STOP_1MIN_NO_CODE = 'aUg2ERYlb3UChMJWTat0fKw';

// Geotab definitions that must never create a board alert. Their events may
// still be archived only when listed in GEOTAB_ARCHIVE_ONLY_SPEEDING_CODES.
const SPEEDING_DEF_NAME = 'speeding';
const SPEEDING_HEAVY_ROAD_NAME = 'heavy duty road speeding rule';
const SPEEDING_HEAVY_ROAD_CODE = 'aP4bSb7nyIUOPJ7ihBm1Idg';
const SPEEDING_GENERIC_CODE = 'speeding';

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

// Geotab feeding these two codes is archived for comparison, never grouped.
const GEOTAB_ARCHIVE_ONLY_SPEEDING_CODES = new Set([
  SPEED_85_CODE.toLowerCase(),
  SPEED_90_CODE.toLowerCase(),
]);

// Geotab feeding these is ignored entirely (not stored, not grouped).
const GEOTAB_DROP_SPEEDING_NAMES = new Set([
  SPEEDING_DEF_NAME,
  SPEEDING_HEAVY_ROAD_NAME,
]);
const GEOTAB_DROP_SPEEDING_CODES = new Set([
  SPEEDING_GENERIC_CODE,
  SPEEDING_HEAVY_ROAD_CODE.toLowerCase(),
]);

const POLLER_SPEEDING_CODES = new Set([SPEED_85_CODE, SPEED_90_CODE]);

const FATIGUE_THRESHOLDS = [
  { minutes: 180, signalCode: FATIGUE_3H_CODE },
  { minutes: 360, signalCode: FATIGUE_6H_CODE },
  { minutes: 480, signalCode: DURATION_8H_CODE },
  { minutes: 540, signalCode: FATIGUE_9H_CODE },
  { minutes: 720, signalCode: DURATION_12H_CODE },
  { minutes: 900, signalCode: DURATION_15H_CODE },
];

function isPollerOwnedAlert(def) {
  if (!def) return false;
  if (POLLER_OWNED_ALARM_NAMES.has(String(def.name || '').trim().toLowerCase())) return true;
  if (POLLER_OWNED_SIGNAL_CODES.has(String(def.signalCode || def.signal_code || '').trim().toLowerCase())) return true;
  return false;
}

function isGeotabSpeedingDefinition(def) {
  if (!def) return false;
  const name = String(def.name || '').trim().toLowerCase();
  const code = String(def.signalCode || def.signal_code || '').trim().toLowerCase();
  return GEOTAB_DROP_SPEEDING_NAMES.has(name)
    || GEOTAB_DROP_SPEEDING_CODES.has(code)
    || GEOTAB_ARCHIVE_ONLY_SPEEDING_CODES.has(code)
    || POLLER_SPEEDING_CODES.has(def.signalCode || def.signal_code);
}

function geotabSpeedingPolicy(def) {
  if (!def) return 'allow';
  const name = String(def.name || '').trim().toLowerCase();
  const code = String(def.signalCode || def.signal_code || '').trim().toLowerCase();
  if (GEOTAB_ARCHIVE_ONLY_SPEEDING_CODES.has(code)) return 'archive_only';
  if (GEOTAB_DROP_SPEEDING_NAMES.has(name) || GEOTAB_DROP_SPEEDING_CODES.has(code)) return 'drop';
  return 'allow';
}

function isPollerSpeedingCode(code) {
  return POLLER_SPEEDING_CODES.has(String(code || ''));
}

module.exports = {
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
  POLLER_OWNED_ALARM_NAMES,
  POLLER_OWNED_SIGNAL_CODES,
  GEOTAB_ARCHIVE_ONLY_SPEEDING_CODES,
  GEOTAB_DROP_SPEEDING_NAMES,
  GEOTAB_DROP_SPEEDING_CODES,
  POLLER_SPEEDING_CODES,
  FATIGUE_THRESHOLDS,
  isPollerOwnedAlert,
  isGeotabSpeedingDefinition,
  geotabSpeedingPolicy,
  isPollerSpeedingCode,
};
