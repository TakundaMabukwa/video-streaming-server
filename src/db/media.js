const { query } = require('./pool');

async function insertMedia(alertId, file) {
  const { fileUrl, fileType, fileSize, deviceName, alarmType } = file;
  await query(
    `INSERT INTO alert_media (alert_id, file_url, file_type, file_size, device_name, alarm_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [alertId, fileUrl, fileType, fileSize || 0, deviceName || null, alarmType || null]
  );
}

async function batchInsertMedia(entries) {
  if (entries.length === 0) return;
  const values = entries.map((_, i) =>
    `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
  ).join(',');
  const params = entries.flatMap(e => [
    e.alertId, e.fileUrl, e.fileType || null,
    e.fileSize || 0, e.deviceName || null, e.alarmType || null,
  ]);
  await query(
    `INSERT INTO alert_media (alert_id, file_url, file_type, file_size, device_name, alarm_type)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params
  );
}

async function mediaExists(alertId, fileUrl) {
  const result = await query(
    'SELECT 1 FROM alert_media WHERE alert_id = $1 AND file_url = $2',
    [alertId, fileUrl]
  );
  return result.rows.length > 0;
}

async function batchMediaExists(entries) {
  if (entries.length === 0) return {};
  const orClauses = entries.map((_, i) => `(alert_id = $${i * 2 + 1} AND file_url = $${i * 2 + 2})`).join(' OR ');
  const params = entries.flatMap(e => [e.alertId, e.fileUrl]);
  const result = await query(
    `SELECT alert_id, file_url FROM alert_media WHERE ${orClauses}`,
    params
  );
  const existing = new Set(result.rows.map(r => `${r.alert_id}::${r.file_url}`));
  return Object.fromEntries(entries.map(e => [`${e.alertId}::${e.fileUrl}`, existing.has(`${e.alertId}::${e.fileUrl}`)]));
}

async function getMediaByAlertIds(alertIds) {
  if (alertIds.length === 0) return [];
  const result = await query(
    'SELECT * FROM alert_media WHERE alert_id = ANY($1::text[]) ORDER BY id',
    [alertIds]
  );
  return result.rows;
}

async function getMediaForAlert(alertId) {
  const result = await query(
    'SELECT * FROM alert_media WHERE alert_id = $1 ORDER BY id',
    [alertId]
  );
  return result.rows;
}

module.exports = {
  insertMedia,
  batchInsertMedia,
  mediaExists,
  batchMediaExists,
  getMediaByAlertIds,
  getMediaForAlert,
};
