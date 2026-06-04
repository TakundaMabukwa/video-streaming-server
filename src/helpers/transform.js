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
  occlusion: 'low',
  sos: 'critical',
};

function toTitle(str) {
  return (str || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim() || 'Alert';
}

function transformDbAlert(record) {
  const alarmType = record.alarm_type || '';
  const priority = PRIORITY_MAP[alarmType] || 'medium';
  const documents = Array.isArray(record.documents) ? record.documents : [];

  return {
    id: record.id,
    alert_type: alarmType,
    type: alarmType,
    priority,
    severity: priority,
    status: record.resolved ? 'resolved' : (record.status || 'new'),
    title: toTitle(alarmType),
    resolved: !!record.resolved,
    false_alert: !!record.false_alert,
    documents,
    notes: record.notes || null,
    escalated: false,
    device_id: record.device_id,
    vehicleId: record.device_id,
    vehicle_registration: record.device_name || record.device_id,
    driver_name: null,
    timestamp: record.alarm_ts ? new Date(record.alarm_ts).toISOString() : new Date().toISOString(),
    created_at: record.created_at ? new Date(record.created_at).toISOString() : null,
    last_occurrence: record.alarm_ts ? new Date(record.alarm_ts).toISOString() : null,
    displayTimestamp: record.alarm_ts ? new Date(record.alarm_ts).toISOString() : null,
    location: {
      latitude: record.lat,
      longitude: record.lon,
      address: null,
    },
    lat: record.lat,
    lon: record.lon,
    metadata: {
      vehicle: {
        vehicleId: record.device_id,
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
