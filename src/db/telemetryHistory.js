const { query } = require('./pool');

async function batchInsertTelemetryHistory(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const values = [];
  const params = [];
  rows.forEach((row, index) => {
    const offset = index * 6;
    params.push(
      row.device_id,
      row.fleet_number || null,
      row.registration || null,
      row.lat,
      row.lon,
      row.event_time
    );
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::timestamptz)`);
  });

  const result = await query(
    `INSERT INTO telemetry_history (device_id, fleet_number, registration, lat, lon, event_time)
     VALUES ${values.join(',')}
     ON CONFLICT (device_id, event_time) DO NOTHING`,
    params
  );
  return result.rowCount || 0;
}

module.exports = { batchInsertTelemetryHistory };
