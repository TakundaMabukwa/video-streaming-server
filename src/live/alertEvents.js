// Shared shape for alert_groups rows on the SSE stream. This is the board
// payload only; modal detail/media is fetched separately on demand.

function toMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function followUpActive(row) {
  if (!row || !row.follow_up || !row.follow_up_at) return false;
  const at = new Date(row.follow_up_at).getTime();
  return Number.isFinite(at) && Date.now() - at < 15 * 60 * 1000;
}

function rowPayload(row) {
  return {
    id: String(row.id),
    fleet_number: row.fleet_number || null,
    device_id: row.device_id || null,
    device_name: row.device_name || null,
    alert_type: row.alarm_type || null,
    alarm_type: row.alarm_type || null,
    alarm_text: row.alarm_text || null,
    severity: followUpActive(row) ? 'low' : String(row.severity || 'low').toLowerCase(),
    follow_up: !!row.follow_up,
    follow_up_at: row.follow_up_at || null,
    original_severity: row.original_severity || null,
    repeated_count: Number(row.count || 1) || 1,
    count: Number(row.count || 1) || 1,
    source_type: row.source_type || 'video',
    last_alert_id: row.last_alert_id || null,
    last_occurrence: toMs(row.last_alert_ts),
    last_alert_ts: row.last_alert_ts || null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    speed: row.speed ?? null,
    distance_km: row.distance_km ?? null,
    duration_seconds: row.duration_seconds ?? null,
    status: row.status || 'new',
    resolved: !!row.resolved,
    false_alert: !!row.false_alert,
    revision: Number(row.revision || 0),
  };
}

function isOpen(row) {
  return !row.resolved && !row.false_alert;
}

function eventFromRow(row) {
  if (!row) return null;
  if (isOpen(row)) {
    return {
      type: 'ALERT_DELTA',
      action: 'UPSERT',
      id: String(row.id),
      fleet_number: row.fleet_number || null,
      revision: Number(row.revision || 0),
      row: rowPayload(row),
    };
  }
  return {
    type: 'ALERT_CLOSED',
    id: String(row.id),
    fleet_number: row.fleet_number || null,
    revision: Number(row.revision || 0),
    resolved: !!row.resolved,
    false_alert: !!row.false_alert,
    status: row.status || 'resolved',
    resolved_at: row.resolved_at || null,
    resolved_by: row.resolved_by || null,
  };
}

module.exports = { eventFromRow, rowPayload, isOpen, toMs };
