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

function toTitle(str) {
  return (str || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim() || 'Alert';
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
  const priority = (severityMap && severityMap[alarmType]) || PRIORITY_MAP[alarmType] || 'medium';
  const documents = Array.isArray(record.documents) ? record.documents : [];
  const ts = record.last_alert_ts || record.alarm_ts;
  const id = record.last_alert_id || record.id;
  const deviceId = record.device_id;

  const media = Array.isArray(record.media) ? record.media : [];
  const screenshotEntries = media
    .filter((m) => m.file_type === '00' || !m.file_type || m.file_type === '01')
    .map((m) => ({
      url: m.file_url,
      file_url: m.file_url,
      timestamp: m.created_at || m.alarm_time,
    }));

  const screenshotUrls = screenshotEntries.map((m) => m.url).filter(Boolean);

  return {
    id,
    alert_type: alarmType,
    type: alarmType,
    priority,
    severity: priority,
    status: record.resolved ? 'resolved' : (record.status || 'new'),
    title: toTitle(alarmType),
    resolved: !!record.resolved,
    false_alert: !!record.false_alert,
    resolved_at: record.resolved_at ? new Date(record.resolved_at).toISOString() : null,
    resolved_by: record.resolved_by || null,
    count: record.count || 1,
    documents,
    notes: record.notes || null,
    escalated: false,
    device_id: deviceId,
    vehicleId: deviceId,
    vehicle_registration: record.device_name || null,
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

module.exports = { transformDbAlert, getAlertCoordinates };
