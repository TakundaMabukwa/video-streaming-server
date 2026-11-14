const { query } = require('./pool');

function dbTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function upsertAlert(alert) {
  const { id, deviceId, deviceName, alarmType, alarmTs, alarmTsEnd, lat, lon, alarmText, serialNo, fenceId, alarmExtension, sourceType = 'video', speed, severity, fleetNumber, distanceKm, durationSeconds } = alert;
  const result = await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, lat, lon, alarm_text, serial_no, fence_id, alarm_extension, source_type, speed, severity, fleet_number, distance_km, duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (id) DO UPDATE SET
       device_name = EXCLUDED.device_name,
       alarm_type = EXCLUDED.alarm_type,
       alarm_ts = EXCLUDED.alarm_ts,
       alarm_ts_end = EXCLUDED.alarm_ts_end,
       lat = EXCLUDED.lat,
       lon = EXCLUDED.lon,
       alarm_text = EXCLUDED.alarm_text,
       serial_no = EXCLUDED.serial_no,
       fence_id = EXCLUDED.fence_id,
       alarm_extension = EXCLUDED.alarm_extension,
       source_type = EXCLUDED.source_type,
       speed = COALESCE(EXCLUDED.speed, alerts.speed),
       severity = COALESCE(NULLIF(EXCLUDED.severity, ''), alerts.severity),
       fleet_number = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alerts.fleet_number),
       distance_km = COALESCE(EXCLUDED.distance_km, alerts.distance_km),
       duration_seconds = COALESCE(EXCLUDED.duration_seconds, alerts.duration_seconds),
       updated_at = NOW()
     RETURNING id`,
    [id, deviceId, deviceName, alarmType, dbTime(alarmTs), dbTime(alarmTsEnd), lat || null, lon || null, alarmText || null, serialNo || null, fenceId || null, alarmExtension || null, sourceType, speed ?? null, severity || null, fleetNumber || null, distanceKm ?? null, durationSeconds ?? null]
  );
  return result.rows[0];
}

async function batchUpsertAlerts(alerts) {
  if (alerts.length === 0) return;
  const values = alerts.map((_, i) =>
    `($${i * 17 + 1}, $${i * 17 + 2}, $${i * 17 + 3}, $${i * 17 + 4}, $${i * 17 + 5}, $${i * 17 + 6}, $${i * 17 + 7}, $${i * 17 + 8}, $${i * 17 + 9}, $${i * 17 + 10}, $${i * 17 + 11}, $${i * 17 + 12}, $${i * 17 + 13}, $${i * 17 + 14}, $${i * 17 + 15}, $${i * 17 + 16}, $${i * 17 + 17})`
  ).join(',');
  const params = alerts.flatMap(a => [
    a.id, a.deviceId, a.deviceName || null, a.alarmType,
    dbTime(a.alarmTs), dbTime(a.alarmTsEnd),
    a.lat || null, a.lon || null,
    a.alarmText || null, a.serialNo || null,
    a.fenceId || null, a.alarmExtension || null,
    a.speed ?? null, a.severity || null, a.fleetNumber || null,
    a.distanceKm ?? null, a.durationSeconds ?? null,
  ]);
  try {
  await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, lat, lon, alarm_text, serial_no, fence_id, alarm_extension, speed, severity, fleet_number, distance_km, duration_seconds)
     VALUES ${values}
     ON CONFLICT (id) DO UPDATE SET
       device_name = EXCLUDED.device_name,
       alarm_type = EXCLUDED.alarm_type,
       alarm_ts = EXCLUDED.alarm_ts,
       alarm_ts_end = EXCLUDED.alarm_ts_end,
       lat = EXCLUDED.lat,
       lon = EXCLUDED.lon,
       alarm_text = EXCLUDED.alarm_text,
       serial_no = EXCLUDED.serial_no,
       fence_id = EXCLUDED.fence_id,
       alarm_extension = EXCLUDED.alarm_extension,
       speed = COALESCE(EXCLUDED.speed, alerts.speed),
       severity = COALESCE(NULLIF(EXCLUDED.severity, ''), alerts.severity),
       fleet_number = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alerts.fleet_number),
       distance_km = COALESCE(EXCLUDED.distance_km, alerts.distance_km),
       duration_seconds = COALESCE(EXCLUDED.duration_seconds, alerts.duration_seconds),
       updated_at = NOW()`,
    params
  );
  } catch (err) {
    console.error('[ALERTS] batch upsert failed:', err.message);
    throw err;
  }
}

// Member linkage choke point: every detection (video sync, Geotab feed,
// poller, auto-NCR) funnels its alert row through here with its group PK.
// Insert-or-fill: never overwrites existing member data, only fills gaps.
async function ensureMemberRow({
  id, deviceId, deviceName, alarmType, alarmText, alarmTs, lat, lon, speed,
  severity, fleetNumber, sourceType = 'video', groupId, sourceDeviceId,
  geotabDeviceId, mettaxDeviceId, distanceKm, durationSeconds,
}) {
  if (!id) return null;
  const result = await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_text, alarm_ts, lat, lon, speed, severity, fleet_number, source_type, alert_group_id, source_device_id, geotab_device_id, mettax_device_id, distance_km, duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (id) DO UPDATE SET
       device_name = COALESCE(NULLIF(EXCLUDED.device_name, ''), alerts.device_name),
       alarm_text = COALESCE(NULLIF(EXCLUDED.alarm_text, ''), alerts.alarm_text),
       lat = COALESCE(EXCLUDED.lat, alerts.lat),
       lon = COALESCE(EXCLUDED.lon, alerts.lon),
       speed = COALESCE(EXCLUDED.speed, alerts.speed),
       severity = COALESCE(NULLIF(EXCLUDED.severity, ''), alerts.severity),
       fleet_number = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alerts.fleet_number),
       source_device_id = COALESCE(EXCLUDED.source_device_id, alerts.source_device_id),
       geotab_device_id = COALESCE(EXCLUDED.geotab_device_id, alerts.geotab_device_id),
       mettax_device_id = COALESCE(EXCLUDED.mettax_device_id, alerts.mettax_device_id),
       distance_km = COALESCE(EXCLUDED.distance_km, alerts.distance_km),
       duration_seconds = COALESCE(EXCLUDED.duration_seconds, alerts.duration_seconds),
       alert_group_id = COALESCE(alerts.alert_group_id, EXCLUDED.alert_group_id),
       updated_at = NOW()
     RETURNING id`,
    [id, deviceId || null, deviceName || null, alarmType || null, alarmText || null, alarmTs || null,
     lat ?? null, lon ?? null, speed ?? null, severity || null, fleetNumber || null, sourceType, groupId || null,
     sourceDeviceId || null, geotabDeviceId || null, mettaxDeviceId || null, distanceKm ?? null, durationSeconds ?? null]
  );
  return result.rows[0] || null;
}

async function alertExists(id) {
  const result = await query('SELECT 1 FROM alerts WHERE id = $1', [id]);
  return result.rows.length > 0;
}

async function batchAlertExists(ids) {
  if (ids.length === 0) return {};
  const result = await query('SELECT id FROM alerts WHERE id = ANY($1::text[])', [ids]);
  const exists = new Set(result.rows.map(r => r.id));
  return Object.fromEntries(ids.map(id => [id, exists.has(id)]));
}

const { getMediaForAlert, getMediaByAlertIds } = require('./media');

async function getGroupMembers(groupId, { limit = 500 } = {}) {
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid < 1) return { rows: [], truncated: false };
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const result = await query(
    `SELECT id, alert_group_id, device_id, device_name, fleet_number,
            alarm_type, alarm_text, alarm_ts, alarm_ts_end,
            lat, lon, speed, distance_km, duration_seconds,
            severity, source_type, status, resolved, false_alert,
            resolved_by, resolved_at, notes, created_at
       FROM alerts
      WHERE alert_group_id = $1
        AND combo_state IS DISTINCT FROM 'pending'
      ORDER BY alarm_ts DESC NULLS LAST, created_at DESC, id DESC
      LIMIT $2`,
    [gid, lim + 1]
  );
  const truncated = result.rows.length > lim;
  return { rows: truncated ? result.rows.slice(0, lim) : result.rows, truncated };
}

async function getAlertOccurrence(alertId) {
  const id = String(alertId || '').trim();
  if (!id) return null;
  const result = await query(
    `SELECT a.*, g.group_key, g.fleet_number AS group_fleet_number
       FROM alerts a
       LEFT JOIN alert_groups g ON g.id = a.alert_group_id
      WHERE a.id = $1
      LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getAlertWithMedia(alertId) {
  const alertResult = await query('SELECT * FROM alerts WHERE id = $1', [alertId]);
  if (alertResult.rows.length === 0) return null;
  const mediaResult = await getMediaForAlert(alertId);
  return { ...alertResult.rows[0], media: mediaResult };
}

async function getAlertsPaginated({ pageSize = 50, pageIndex = 1, deviceIds, alarmType, startTime, endTime }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (deviceIds) {
    const ids = deviceIds.split(',').filter(Boolean);
    if (ids.length > 0) {
      conditions.push(`device_id = ANY($${paramIndex})`);
      params.push(ids);
      paramIndex++;
    }
  }
  if (alarmType) {
    conditions.push(`alarm_type = ANY($${paramIndex})`);
    params.push(alarmType.split(',').filter(Boolean));
    paramIndex++;
  }
  if (startTime) {
    conditions.push(`alarm_ts >= $${paramIndex}`);
    params.push(startTime);
    paramIndex++;
  }
  if (endTime) {
    conditions.push(`alarm_ts <= $${paramIndex}`);
    params.push(endTime);
    paramIndex++;
  }

  // While a combo is still waiting for its other members this detection is
  // withheld from member lists / timelines. Its individual board card is
  // already raised; the row is released when the combo completes or expires.
  conditions.push(`combo_state IS DISTINCT FROM 'pending'`);

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (pageIndex - 1) * pageSize;

  const countResult = await query(`SELECT COUNT(*) FROM alerts ${where}`, params);
  const total = parseInt(countResult.rows[0].count);

  const dataResult = await query(
    `SELECT * FROM alerts ${where} ORDER BY alarm_ts DESC NULLS LAST LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, pageSize, offset]
  );

  const alertIds = dataResult.rows.map(r => r.id);
  const mediaMap = {};
  if (alertIds.length > 0) {
    const mediaRows = await getMediaByAlertIds(alertIds);
    for (const m of mediaRows) {
      if (!mediaMap[m.alert_id]) mediaMap[m.alert_id] = [];
      mediaMap[m.alert_id].push(m);
    }
  }

  const records = dataResult.rows.map(r => ({ ...r, media: mediaMap[r.id] || [] }));
  return { records, total, size: pageSize, current: pageIndex };
}

async function getAlertsWithoutMedia(limit = 200) {
  const result = await query(
    `SELECT a.* FROM alerts a
     LEFT JOIN alert_media m ON m.alert_id = a.id
     WHERE m.id IS NULL
     ORDER BY a.alarm_ts DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getActiveAlertsWithMedia({ pageSize = 2000, pageIndex = 1 }) {
  const offset = (pageIndex - 1) * pageSize;
  // Combo-held detections are not alerts yet, so they never count here either.
  const countResult = await query(
    `SELECT COUNT(*) FROM alerts a
     WHERE a.combo_state IS DISTINCT FROM 'pending'
       AND EXISTS (SELECT 1 FROM alert_media m WHERE m.alert_id = a.id)`
  );
  const total = parseInt(countResult.rows[0].count);
  const dataResult = await query(
    `SELECT a.* FROM alerts a
     WHERE a.combo_state IS DISTINCT FROM 'pending'
       AND EXISTS (SELECT 1 FROM alert_media m WHERE m.alert_id = a.id)
     ORDER BY a.alarm_ts DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );
  return { records: dataResult.rows, total, size: pageSize, current: pageIndex };
}

async function getStats() {
  const alertCount = await query('SELECT COUNT(*) FROM alerts');
  const mediaCount = await query('SELECT COUNT(*) FROM alert_media');
  const deviceCount = await query('SELECT COUNT(DISTINCT device_id) FROM alerts');
  return {
    totalAlerts: parseInt(alertCount.rows[0].count),
    totalMedia: parseInt(mediaCount.rows[0].count),
    totalDevices: parseInt(deviceCount.rows[0].count),
  };
}

module.exports = {
  upsertAlert,
  batchUpsertAlerts,
  ensureMemberRow,
  alertExists,
  batchAlertExists,
  getGroupMembers,
  getAlertOccurrence,
  getAlertWithMedia,
  getAlertsPaginated,
  getAlertsWithoutMedia,
  getActiveAlertsWithMedia,
  getStats,
};
