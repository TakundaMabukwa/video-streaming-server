const { query } = require('./pool');

async function upsertAlertGroup({ deviceId, deviceName, alarmType, alarmText, alertId, alarmTs, lat, lon }) {
  const groupKey = `${deviceId}:${alarmType}`.toLowerCase();
  const result = await query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)
     ON CONFLICT (group_key) DO UPDATE SET
       count = alert_groups.count + 1,
       last_alert_id = $6,
       last_alert_ts = $7,
       device_name = COALESCE(NULLIF($3, ''), alert_groups.device_name),
       lat = COALESCE($8, alert_groups.lat),
       lon = COALESCE($9, alert_groups.lon),
       alarm_text = COALESCE(NULLIF($5, ''), alert_groups.alarm_text),
       updated_at = NOW()
     RETURNING id`,
    [groupKey, deviceId, deviceName, alarmType, alarmText, alertId, alarmTs, lat, lon]
  );
  return result.rows[0];
}

async function batchUpsertAlertGroups(groups) {
  if (!groups || groups.length === 0) return [];
  const params = [];
  const placeholders = groups.map((g, i) => {
    const base = i * 9;
    params.push(
      `${g.deviceId}:${g.alarmType}`.toLowerCase(),
      g.deviceId, g.deviceName || null, g.alarmType, g.alarmText || null,
      g.alertId, g.alarmTs || null, g.lat || null, g.lon || null
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 1, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  }).join(',');
  const result = await query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon)
     VALUES ${placeholders}
     ON CONFLICT (group_key) DO UPDATE SET
       count = alert_groups.count + 1,
       last_alert_id = EXCLUDED.last_alert_id,
       last_alert_ts = EXCLUDED.last_alert_ts,
       device_name = COALESCE(NULLIF(EXCLUDED.device_name, ''), alert_groups.device_name),
       lat = COALESCE(EXCLUDED.lat, alert_groups.lat),
       lon = COALESCE(EXCLUDED.lon, alert_groups.lon),
       alarm_text = COALESCE(NULLIF(EXCLUDED.alarm_text, ''), alert_groups.alarm_text),
       updated_at = NOW()
     RETURNING id, group_key`,
    params
  );
  return result.rows;
}

async function getActiveAlertGroups({ limit = 2000 } = {}) {
  const result = await query(
    `SELECT g.* FROM alert_groups g
     WHERE g.resolved = FALSE
     ORDER BY g.last_alert_ts DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getAlertGroupById(id) {
  const result = await query('SELECT * FROM alert_groups WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getAlertGroupByKey(groupKey) {
  const result = await query('SELECT * FROM alert_groups WHERE group_key = $1', [groupKey.toLowerCase()]);
  return result.rows[0] || null;
}

async function getAlertGroupByAlertId(alertId) {
  const result = await query(
    `SELECT g.* FROM alert_groups g
     WHERE g.last_alert_id = $1
     LIMIT 1`,
    [alertId]
  );
  return result.rows[0] || null;
}

async function getActiveAlertGroupsWithMedia({ limit = 2000 } = {}) {
  const result = await query(
    `SELECT g.*,
            jsonb_agg(DISTINCT jsonb_build_object(
              'id', m.id, 'file_url', m.file_url, 'file_type', m.file_type,
              'file_size', m.file_size, 'created_at', m.created_at
            )) FILTER (WHERE m.id IS NOT NULL) AS media
     FROM alert_groups g
     INNER JOIN alert_media m ON m.alert_id = g.last_alert_id
     WHERE g.resolved = FALSE
     GROUP BY g.id
     HAVING COUNT(m.id) > 0
     ORDER BY g.last_alert_ts DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(r => ({
    ...r,
    media: (r.media || []).filter(m => m.id !== null)
  }));
}

async function resolveAlertGroup(groupKey, updates) {
  const sets = [];
  const params = [];
  let idx = 1;

  if (updates.resolved !== undefined) {
    sets.push(`resolved = $${idx++}`);
    params.push(updates.resolved);
  }
  if (updates.false_alert !== undefined) {
    sets.push(`false_alert = $${idx++}`);
    params.push(updates.false_alert);
  }
  if (updates.resolved_by !== undefined) {
    sets.push(`resolved_by = $${idx++}`);
    params.push(updates.resolved_by);
  }
  if (updates.resolved_at !== undefined) {
    sets.push(`resolved_at = $${idx++}`);
    params.push(updates.resolved_at);
  }
  if (updates.notes !== undefined) {
    sets.push(`notes = $${idx++}`);
    params.push(updates.notes);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  sets.push(`updated_at = NOW()`);

  params.push(groupKey.toLowerCase());
  const result = await query(
    `UPDATE alert_groups SET ${sets.join(', ')} WHERE group_key = $${idx} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function getAlertGroupStats() {
  const groupCount = await query('SELECT COUNT(*) FROM alert_groups');
  const activeCount = await query('SELECT COUNT(*) FROM alert_groups WHERE resolved = FALSE');
  return {
    totalGroups: parseInt(groupCount.rows[0].count),
    activeGroups: parseInt(activeCount.rows[0].count),
  };
}

module.exports = {
  upsertAlertGroup,
  batchUpsertAlertGroups,
  getActiveAlertGroups,
  getAlertGroupById,
  getAlertGroupByKey,
  getAlertGroupByAlertId,
  getActiveAlertGroupsWithMedia,
  resolveAlertGroup,
  getAlertGroupStats,
};
