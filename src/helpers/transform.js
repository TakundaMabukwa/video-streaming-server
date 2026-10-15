const PRIORITY_MAP = {
  fatigueWarn: 'high',
  fatigueAlarm: 'critical',
  bang: 'critical',
  handheldPhoneCall: 'high',
  seatBelt: 'medium',
  laneShift: 'medium',
  closeProximity: 'high',
  hardBraking: 'high',
  driverNotDetected: 'medium',
  forwardCollisionWarning: 'critical',
  pedestrianBang: 'critical',
  overtime: 'low',
  speed: 'high',
  powerCut: 'medium',
  occlusion: 'critical',
  sos: 'critical',
};

const SEVERITY_LADDER = ['low', 'medium', 'high', 'critical'];
const ESCALATE_EVERY_N_EVENTS = 3;

function resolveBaseSeverity(alarmType, severityMap) {
  const alarmKey = String(alarmType || '').toLowerCase();
  if (severityMap && severityMap[alarmKey]) return severityMap[alarmKey];
  if (PRIORITY_MAP[alarmType]) return PRIORITY_MAP[alarmType];
  return 'medium';
}

// Every N events, climb one level from the base severity (capped at critical).
// count 1-2 → base, 3 → +1, 4-5 → +1, 6 → +2, 9 → +3, …
function escalateSeverity(baseSeverity, count) {
  const base = String(baseSeverity || 'medium').toLowerCase();
  let idx = SEVERITY_LADDER.indexOf(base);
  if (idx < 0) idx = 2;
  const events = Math.max(1, Number(count) || 1);
  const steps = Math.floor(events / ESCALATE_EVERY_N_EVENTS);
  return SEVERITY_LADDER[Math.min(SEVERITY_LADDER.length - 1, idx + steps)];
}

function toTitle(str) {
  return (str || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim() || 'Alert';
}

// "EX69 - LDR067MP" / "RH34 (REMCO) - JFR719FS" → fleet prefix before " - "
function fleetFromDeviceName(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  const parts = s.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const fleet = parts.find((p) => /^[A-Za-z]{2,}[\w()\- ]*$/.test(p)) || parts[0];
  return fleet || null;
}

/**
 * Transform a raw alert_groups record into a frontend-friendly alert object.
 * @param {object} record - raw DB row from alert_groups
 * @param {object} [severityMap] - optional signal_code → severity map from alert_definitions.
 *   When provided, severity is looked up from this map first.
 *   Falls back to hardcoded PRIORITY_MAP if not found.
 */
function transformDbAlert(record, severityMap) {
  const alarmType = record.alarm_type || '';
  const count = Number(record.count) || 1;
  const basePriority = resolveBaseSeverity(alarmType, severityMap);
  const priority = escalateSeverity(basePriority, count);
  const escalationSteps = Math.min(
    SEVERITY_LADDER.length - 1,
    Math.max(0, SEVERITY_LADDER.indexOf(String(basePriority).toLowerCase())) +
      Math.floor(count / ESCALATE_EVERY_N_EVENTS)
  ) - Math.max(0, SEVERITY_LADDER.indexOf(String(basePriority).toLowerCase()));
  const documents = Array.isArray(record.documents) ? record.documents : [];
  const ts = record.last_alert_ts || record.alarm_ts;
  // Always expose alert_groups PK as id — resolve targets this only.
  const id = record.id != null ? String(record.id) : '';
  const deviceId = record.device_id;

  // Follow-up: if follow_up is active and within 15 minutes, override severity to low
  let effectiveSeverity = priority;
  if (record.follow_up && record.follow_up_at) {
    const followUpTime = new Date(record.follow_up_at).getTime();
    const elapsed = Date.now() - followUpTime;
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    if (elapsed < FIFTEEN_MIN_MS) {
      effectiveSeverity = 'low';
    }
  }

  const media = Array.isArray(record.media) ? record.media : [];
  const screenshotEntries = media
    .filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01')
    .map((m) => ({
      url: m.file_url,
      file_url: m.file_url,
      timestamp: m.created_at || m.alarm_time,
    }));

  const screenshotUrls = screenshotEntries.map((m) => m.url).filter(Boolean);

  const speedNum = record.speed == null || record.speed === '' ? null : Number(record.speed);
  return {
    id,
    last_alert_id: record.last_alert_id || null,
    alarmId: record.last_alert_id || null,
    alert_type: alarmType,
    speed: Number.isFinite(speedNum) ? speedNum : null,
    type: alarmType,
    priority: effectiveSeverity,
    severity: effectiveSeverity,
    base_severity: basePriority,
    escalation_steps: escalationSteps,
    original_severity: record.follow_up ? priority : null,
    follow_up: !!record.follow_up,
    follow_up_at: record.follow_up_at ? new Date(record.follow_up_at).toISOString() : null,
    status: record.resolved ? 'resolved' : (record.status || 'new'),
    title: toTitle(alarmType || record.alarm_text),
    alarm_text: record.alarm_text || '',
    resolved: !!record.resolved,
    false_alert: !!record.false_alert,
    resolved_at: record.resolved_at ? new Date(record.resolved_at).toISOString() : null,
    resolved_by: record.resolved_by || null,
    count,
    documents,
    notes: record.notes || null,
    escalated: escalationSteps > 0,
    source_type: record.source_type || 'video',
    group_key: record.group_key || null,
    device_id: deviceId,
    vehicleId: deviceId,
    vehicle_registration: record.device_name || null,
    // Stored authoritative fleet first (exact registries at creation);
    // parsed name fallback is display-only, never used for matching.
    fleet_number: record.fleet_number || fleetFromDeviceName(record.device_name) || null,
    driver_name: null,
    timestamp: ts ? new Date(ts).toISOString() : new Date().toISOString(),
    created_at: record.created_at ? new Date(record.created_at).toISOString() : null,
    last_occurrence: ts ? new Date(ts).toISOString() : null,
    displayTimestamp: ts ? new Date(ts).toISOString() : null,
    screenshotUrls,
    media: { screenshots: screenshotEntries },
    location: {
      latitude: record.lat,
      longitude: record.lon,
      address: null,
    },
    lat: record.lat,
    lon: record.lon,
    metadata: {
      vehicle: {
        vehicleId: deviceId,
        plateNumber: record.device_name,
      },
      ...(Number.isFinite(speedNum) ? { speed: speedNum } : {}),
    },
  };
}

function getAlertCoordinates(alert) {
  const lat = alert?.lat || alert?.location?.latitude || alert?.metadata?.latitude;
  const lon = alert?.lon || alert?.location?.longitude || alert?.metadata?.longitude;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { latitude: lat, longitude: lon };
  }
  return null;
}

module.exports = {
  transformDbAlert,
  getAlertCoordinates,
  resolveBaseSeverity,
  escalateSeverity,
  SEVERITY_LADDER,
  ESCALATE_EVERY_N_EVENTS,
};
