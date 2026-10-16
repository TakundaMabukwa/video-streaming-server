const { query } = require('./pool');

async function upsertAlert(alert) {
  const { id, deviceId, deviceName, alarmType, alarmTs, alarmTsEnd, lat, lon, alarmText, serialNo, fenceId, alarmExtension, sourceType = 'video', speed, severity, fleetNumber } = alert;
  const result = await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, lat, lon, alarm_text, serial_no, fence_id, alarm_extension, source_type, speed, severity, fleet_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
       updated_at = NOW()
     RETURNING id`,
    [id, deviceId, deviceName, alarmType, alarmTs || null, alarmTsEnd || null, lat || null, lon || null, alarmText || null, serialNo || null, fenceId || null, alarmExtension || null, sourceType, speed ?? null, severity || null, fleetNumber || null]
  );
  return result.rows[0];
}

async function batchUpsertAlerts(alerts) {
  if (alerts.length === 0) return;
  const values = alerts.map((_, i) =>
    `($${i * 15 + 1}, $${i * 15 + 2}, $${i * 15 + 3}, $${i * 15 + 4}, $${i * 15 + 5}, $${i * 15 + 6}, $${i * 15 + 7}, $${i * 15 + 8}, $${i * 15 + 9}, $${i * 15 + 10}, $${i * 15 + 11}, $${i * 15 + 12}, $${i * 15 + 13}, $${i * 15 + 14}, $${i * 15 + 15})`
  ).join(',');
  const params = alerts.flatMap(a => [
    a.id, a.deviceId, a.deviceName || null, a.alarmType,
    a.alarmTs || null, a.alarmTsEnd || null,
    a.lat || null, a.lon || null,
    a.alarmText || null, a.serialNo || null,
    a.fenceId || null, a.alarmExtension || null,
    a.speed ?? null, a.severity || null, a.fleetNumber || null,
  ]);
  await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, lat, lon, alarm_text, serial_no, fence_id, alarm_extension, speed, severity, fleet_number)
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
       updated_at = NOW()`,
    params
  );
}

// Member linkage choke point: every detection (video sync, Geotab feed,
// poller, auto-NCR) funnels its alert row through here with its group PK.
// Insert-or-fill: never overwrites existing member data, only fills gaps.
async function ensureMemberRow({ id, deviceId, deviceName, alarmType, alarmText, alarmTs, lat, lon, speed, severity, fleetNumber, sourceType = 'video', groupId }) {
  if (!id) return null;
  const result = await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_text, alarm_ts, lat, lon, speed, severity, fleet_number, source_type, alert_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       device_name = COALESCE(NULLIF(EXCLUDED.device_name, ''), alerts.device_name),
       alarm_text = COALESCE(NULLIF(EXCLUDED.alarm_text, ''), alerts.alarm_text),
       lat = COALESCE(EXCLUDED.lat, alerts.lat),
       lon = COALESCE(EXCLUDED.lon, alerts.lon),
       speed = COALESCE(EXCLUDED.speed, alerts.speed),
       severity = COALESCE(NULLIF(EXCLUDED.severity, ''), alerts.severity),
       fleet_number = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alerts.fleet_number),
       alert_group_id = COALESCE(alerts.alert_group_id, EXCLUDED.alert_group_id),
       updated_at = NOW()
     RETURNING id`,
    [id, deviceId || null, deviceName || null, alarmType || null, alarmText || null, alarmTs || null,
     lat ?? null, lon ?? null, speed ?? null, severity || null, fleetNumber || null, sourceType, groupId || null]
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
  const countResult = await query(
    'SELECT COUNT(*) FROM alerts a WHERE EXISTS (SELECT 1 FROM alert_media m WHERE m.alert_id = a.id)'
  );
  const total = parseInt(countResult.rows[0].count);
  const dataResult = await query(
    `SELECT a.* FROM alerts a
     WHERE EXISTS (SELECT 1 FROM alert_media m WHERE m.alert_id = a.id)
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
  getAlertWithMedia,
  getAlertsPaginated,
  getAlertsWithoutMedia,
  getActiveAlertsWithMedia,
  getStats,
};
