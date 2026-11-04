const {
  ZONE_ENTRY_CODE,
  NOGO_ENTRY_CODE,
  NO_STOP_ENTRY_CODE,
  ZONE_STOP_IMMEDIATE_CODE,
  ZONE_STOP_1MIN_HIGH_CODE,
  ZONE_STOP_1MIN_NO_CODE,
} = require('./catalog');

const CATEGORIES = new Set(['high_risk', 'no_go', 'no_stopping', 'normal']);

function normalizeCategory(value) {
  const c = String(value || '').trim().toLowerCase();
  return CATEGORIES.has(c) ? c : null;
}

// One category per zone. The explicit column wins. For legacy rows without it,
// high_risk wins over no_go (the chosen default for conflicting flags).
function categoryOf(zone = {}) {
  const explicit = normalizeCategory(zone.zone_category);
  if (explicit) return explicit;
  if (zone.is_high_risk) return 'high_risk';
  if (zone.is_no_go) return 'no_go';
  if (zone.is_no_stopping) return 'no_stopping';
  return 'normal';
}

function flagsFor(category) {
  const c = normalizeCategory(category) || 'normal';
  return {
    is_high_risk: c === 'high_risk',
    is_no_go: c === 'no_go',
    is_no_stopping: c === 'no_stopping',
  };
}

function entrySignalCode(category) {
  switch (normalizeCategory(category)) {
    case 'no_go': return NOGO_ENTRY_CODE;
    case 'no_stopping': return NO_STOP_ENTRY_CODE;
    case 'high_risk': return ZONE_ENTRY_CODE;
    default: return null;
  }
}

function entryLabel(category) {
  switch (normalizeCategory(category)) {
    case 'no_go': return { code: NOGO_ENTRY_CODE, text: 'No-Go Zone' };
    case 'no_stopping': return { code: NO_STOP_ENTRY_CODE, text: 'No Stopping Zone' };
    case 'high_risk': return { code: ZONE_ENTRY_CODE, text: 'High Risk Area' };
    default: return null;
  }
}

function riskLevel(category) {
  switch (normalizeCategory(category)) {
    case 'no_go': return 'CRITICAL';
    case 'high_risk': return 'HIGH';
    case 'no_stopping': return 'MEDIUM';
    default: return 'LOW';
  }
}

function stopSignalCodes(category) {
  const c = normalizeCategory(category);
  return {
    immediate: ZONE_STOP_IMMEDIATE_CODE,
    minute: c === 'no_stopping' ? ZONE_STOP_1MIN_NO_CODE : ZONE_STOP_1MIN_HIGH_CODE,
    isNoStopping: c === 'no_stopping',
  };
}

module.exports = {
  categoryOf,
  flagsFor,
  normalizeCategory,
  entrySignalCode,
  entryLabel,
  riskLevel,
  stopSignalCodes,
};
