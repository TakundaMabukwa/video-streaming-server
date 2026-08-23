const { query } = require('./pool');

async function upsertAlert(alert) {
  const { id, deviceId, deviceName, alarmType, alarmTs, alarmTsEnd, lat, lon, alarmText, serialNo, fenceId, alarmExtension, sourceType = 'video' } = alert;
  const result = await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, lat, lon, alarm_text, serial_no, fence_id, alarm_extension, source_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
       updated_at = NOW()
     RETURNING id`,
    [id, deviceId, deviceName, alarmType, alarmTs, alarmTsEnd, lat, lon, alarmText, serialNo, fenceId, alarmExtension, sourceType]
  );
  return result.rows[0];
}

async function batchUpsertAlerts(alerts) {
  if (alerts.length === 0) return;
  const values = alerts.map((_, i) =>
    `($${i * 12 + 1}, $${i * 12 + 2}, $${i * 12 + 3}, $${i * 12 + 4}, $${i * 12 + 5}, $${i * 12 + 6}, $${i * 12 + 7}, $${i * 12 + 8}, $${i * 12 + 9}, $${i * 12 + 10}, $${i * 12 + 11}, $${i * 12 + 12})`
  ).join(',');
  const params = alerts.flatMap(a => [
    a.id, a.deviceId, a.deviceName || null, a.alarmType,
    a.alarmTs || null, a.alarmTsEnd || null,
    a.lat || null, a.lon || null,
    a.alarmText || null, a.serialNo || null,
    a.fenceId || null, a.alarmExtension || null,
  ]);
  await query(
    `INSERT INTO alerts (id, device_id, device_name, alarm_type, alarm_ts, alarm_ts_end, lat, lon, alarm_text, serial_no, fence_id, alarm_extension)
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
       updated_at = NOW()`,
    params
  );
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
  alertExists,
  batchAlertExists,
  getAlertWithMedia,
  getAlertsPaginated,
  getAlertsWithoutMedia,
  getActiveAlertsWithMedia,
  getStats,
};
