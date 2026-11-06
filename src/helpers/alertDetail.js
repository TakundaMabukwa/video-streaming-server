// Serializers for the alert-detail API. They intentionally use the alert's
// own stored speed/distance/duration and never enrich from telematics_events.

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function followUpActive(row) {
  if (!row?.follow_up || !row?.follow_up_at) return false;
  const started = new Date(row.follow_up_at).getTime();
  return Number.isFinite(started) && Date.now() - started < 15 * 60 * 1000;
}

function severityOf(row) {
  if (followUpActive(row)) return 'low';
  return String(row?.severity || row?.priority || 'medium').toLowerCase();
}

function groupAlert(row) {
  if (!row) return null;
  const lng = row.lon ?? row.lng ?? null;
  const distance = num(row.distance_km);
  const duration = num(row.duration_seconds);
  return {
    id: String(row.id),
    group_id: Number(row.id),
    alert_id: row.last_alert_id || null,
    last_alert_id: row.last_alert_id || null,
    group_key: row.group_key || null,
    fleet_number: row.fleet_number || null,
    device_id: row.device_id || null,
    device_name: row.device_name || null,
    source_device_id: row.source_device_id || null,
    geotab_device_id: row.geotab_device_id || null,
    mettax_device_id: row.mettax_device_id || null,
    alert_type: row.alarm_type || null,
    title: row.alarm_type || row.alarm_text || 'Alert',
    alarm_text: row.alarm_text || null,
    severity: severityOf(row),
    base_severity: String(row.severity || 'medium').toLowerCase(),
    status: row.resolved ? 'resolved' : (row.status || 'new'),
    source_type: row.source_type || 'video',
    count: Number(row.count || 1) || 1,
    last_occurrence: iso(row.last_alert_ts),
    last_alert_ts: iso(row.last_alert_ts),
    speed: num(row.speed),
    distance,
    distance_km: distance,
    duration,
    duration_seconds: duration,
    lat: num(row.lat),
    lon: num(lng),
    resolved: !!row.resolved,
    false_alert: !!row.false_alert,
    resolved_at: iso(row.resolved_at),
    resolved_by: row.resolved_by || null,
    notes: row.notes || null,
    follow_up: !!row.follow_up,
    follow_up_at: iso(row.follow_up_at),
    original_severity: row.original_severity || null,
    documents: Array.isArray(row.documents) ? row.documents : [],
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function memberAlert(row) {
  if (!row) return null;
  const distance = num(row.distance_km);
  const duration = num(row.duration_seconds);
  const id = String(row.id);
  return {
    id,
    alert_id: id,
    group_id: row.alert_group_id == null ? null : Number(row.alert_group_id),
    group_key: row.group_key || null,
    fleet_number: row.fleet_number || row.group_fleet_number || null,
    device_id: row.device_id || null,
    device_name: row.device_name || null,
    source_device_id: row.source_device_id || null,
    geotab_device_id: row.geotab_device_id || null,
    mettax_device_id: row.mettax_device_id || null,
    alert_type: row.alarm_type || null,
    title: row.alarm_type || row.alarm_text || 'Alert',
    alarm_text: row.alarm_text || null,
    timestamp: iso(row.alarm_ts),
    alarm_ts: iso(row.alarm_ts),
    last_occurrence: iso(row.alarm_ts),
    alarm_ts_end: iso(row.alarm_ts_end),
    severity: severityOf(row),
    base_severity: String(row.severity || 'medium').toLowerCase(),
    source_type: row.source_type || 'video',
    status: row.resolved ? 'resolved' : (row.status || 'new'),
    speed: num(row.speed),
    distance,
    distance_km: distance,
    duration,
    duration_seconds: duration,
    lat: num(row.lat),
    lon: num(row.lon ?? row.lng),
    resolved: !!row.resolved,
    false_alert: !!row.false_alert,
    resolved_at: iso(row.resolved_at),
    resolved_by: row.resolved_by || null,
    notes: row.notes || null,
    created_at: iso(row.created_at),
  };
}

module.exports = { groupAlert, memberAlert };
