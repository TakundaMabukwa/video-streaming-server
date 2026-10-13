const { query } = require('./pool');
const { isRegisteredVehicle } = require('../services/fleetRegistryGuard');

async function upsertAlertGroup({ deviceId, deviceName, alarmType, alarmText, alertId, alarmTs, lat, lon, sourceType = 'video', severity }) {
  // Only vehicles in fleet_vehicles may raise alerts.
  if (!(await isRegisteredVehicle({ deviceId, deviceName }))) return null;

  const baseKey = `${deviceId}:${alarmType}`.toLowerCase();

  // Reuse the current ACTIVE (unresolved) group for this device+type: bump the
  // counter and refresh the timestamp so the group keeps showing recent time.
  const active = await query(
    `SELECT group_key FROM alert_groups
     WHERE device_id = $1 AND alarm_type = $2 AND source_type = $3 AND resolved = FALSE
     ORDER BY last_alert_ts DESC NULLS LAST
     LIMIT 1`,
    [deviceId, alarmType, sourceType]
  );

  if (active.rows.length > 0) {
    const groupKey = active.rows[0].group_key;
    const result = await query(
      `UPDATE alert_groups SET
         count = alert_groups.count + 1,
         last_alert_id = $1,
         last_alert_ts = $2,
         device_name = COALESCE(NULLIF($3, ''), alert_groups.device_name),
         lat = COALESCE($4, alert_groups.lat),
         lon = COALESCE($5, alert_groups.lon),
         alarm_text = COALESCE(NULLIF($6, ''), alert_groups.alarm_text),
         severity = COALESCE(NULLIF($7, ''), alert_groups.severity),
         updated_at = NOW()
       WHERE group_key = $8
       RETURNING id, group_key, count, alarm_type`,
      [alertId, alarmTs, deviceName, lat, lon, alarmText, severity, groupKey]
    );
    return result.rows[0];
  }

  // No active group. (No resolve cooldown — a new event after a manual
  // resolve always starts a fresh active group immediately.)
  // If the base key is still taken by a resolved (closed) group, the code
  // below picks a fresh unique key so this alert surfaces in its own group
  // instead of merging into the resolved one.
  let groupKey = baseKey;
  const taken = await query('SELECT 1 FROM alert_groups WHERE group_key = $1', [groupKey]);
  if (taken.rows.length > 0) {
    groupKey = `${baseKey}:${Date.now().toString(36)}${alertId ? '-' + String(alertId).slice(-6) : ''}`;
  }

  const result = await query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, source_type, severity)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
     RETURNING id, group_key, count, alarm_type`,
    [groupKey, deviceId, deviceName, alarmType, alarmText, alertId, alarmTs || null, lat, lon, sourceType, severity]
  );
  return result.rows[0];
}

async function batchUpsertAlertGroups(groups) {
  if (!groups || groups.length === 0) return [];
  // Only vehicles in fleet_vehicles may raise alerts.
  const allowed = [];
  for (const g of groups) {
    if (await isRegisteredVehicle({ deviceId: g.deviceId, deviceName: g.deviceName })) allowed.push(g);
  }
  if (allowed.length === 0) return [];
  // One entry per device+type: ON CONFLICT cannot touch the same row twice.
  const byKey = new Map();
  for (const g of allowed) byKey.set(`${g.deviceId}:${g.alarmType}`.toLowerCase(), g);
  const entries = Array.from(byKey.values());

  const params = [];
  const placeholders = entries.map((g, i) => {
    const base = i * 10;
    params.push(
      `${g.deviceId}:${g.alarmType}`.toLowerCase(),
      g.deviceId, g.deviceName || null, g.alarmType, g.alarmText || null,
      g.alertId, g.alarmTs || null, g.lat || null, g.lon || null, g.severity || null
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 1, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
  }).join(',');
  // On conflict only bump ACTIVE groups. Resolved groups stay closed (Resolve sticks).
  const result = await query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, severity)
     VALUES ${placeholders}
     ON CONFLICT (group_key) DO UPDATE SET
       count = alert_groups.count + 1,
       last_alert_id = EXCLUDED.last_alert_id,
       last_alert_ts = EXCLUDED.last_alert_ts,
       device_name = COALESCE(NULLIF(EXCLUDED.device_name, ''), alert_groups.device_name),
       lat = COALESCE(EXCLUDED.lat, alert_groups.lat),
       lon = COALESCE(EXCLUDED.lon, alert_groups.lon),
       alarm_text = COALESCE(NULLIF(EXCLUDED.alarm_text, ''), alert_groups.alarm_text),
       severity = COALESCE(NULLIF(EXCLUDED.severity, ''), alert_groups.severity),
       updated_at = NOW()
       WHERE alert_groups.resolved = FALSE
       RETURNING id, group_key, count, alarm_type`,
    params
  );

  // A conflict against a RESOLVED group satisfies neither the INSERT nor the
  // DO UPDATE (the WHERE kills it), so no row comes back. Mirror upsertAlertGroup()
  // and open a fresh active twin for those keys — otherwise the raw alert is
  // already in `alerts`, the sync high-water mark advances past it, and the
  // event never reaches alert_groups or the frontend.
  //
  // The base key is squatted by the resolved row forever, so a naive new-group
  // per event leaves the event as a separate single-count group on every sync
  // tick (seen live: 600+ separate "Driver Not Detected" groups for one device).
  // First reuse an existing OPEN group for the same device+type and bump its
  // count; only open a new twin when no open group exists at all.
  const settled = new Set(result.rows.map((r) => r.group_key));
  const twins = entries.filter((g) => !settled.has(`${g.deviceId}:${g.alarmType}`.toLowerCase()));
  if (twins.length > 0) {
    const stamp = Date.now().toString(36);
    for (const g of twins) {
      const existing = await query(
        `SELECT group_key FROM alert_groups
         WHERE device_id = $1 AND alarm_type = $2 AND source_type = $3 AND resolved = FALSE
         ORDER BY last_alert_ts DESC NULLS LAST
         LIMIT 1`,
        [g.deviceId, g.alarmType, g.sourceType || 'video']
      );
      if (existing.rows.length > 0) {
        const bumped = await query(
          `UPDATE alert_groups SET
             count = alert_groups.count + 1,
             last_alert_id = $1,
             last_alert_ts = $2,
             device_name = COALESCE(NULLIF($3, ''), alert_groups.device_name),
             lat = COALESCE($4, alert_groups.lat),
             lon = COALESCE($5, alert_groups.lon),
             alarm_text = COALESCE(NULLIF($6, ''), alert_groups.alarm_text),
             severity = COALESCE(NULLIF($7, ''), alert_groups.severity),
             updated_at = NOW()
           WHERE group_key = $8 AND resolved = FALSE
           RETURNING id, group_key, count, alarm_type`,
          [g.alertId, g.alarmTs || null, g.deviceName || null, g.lat || null, g.lon || null, g.alarmText || null, g.severity || null, existing.rows[0].group_key]
        );
        if (bumped.rows.length > 0) {
          result.rows.push(bumped.rows[0]);
          continue;
        }
      }
      const freshKey = `${g.deviceId}:${g.alarmType}`.toLowerCase() + ':' + stamp +
        `${g.alertId ? '-' + String(g.alertId).slice(-6) : ''}-${Math.random().toString(36).slice(2, 7)}`;
      const inserted = await query(
        `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, source_type, severity)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
         RETURNING id, group_key, count, alarm_type`,
        [freshKey, g.deviceId, g.deviceName || null, g.alarmType, g.alarmText || null,
         g.alertId, g.alarmTs || null, g.lat || null, g.lon || null, g.sourceType || 'video', g.severity || null]
      );
      if (inserted.rows.length > 0) result.rows.push(inserted.rows[0]);
    }
    console.log(`[ALERT-GROUPS] resolved-key twins: ${twins.length} device+type(s) reconciled`);
  }

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
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) return null;
  const result = await query('SELECT * FROM alert_groups WHERE id = $1', [n]);
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

// `limit` of null/0/undefined means "no LIMIT" — callers that want every row
// (currently the dashboard's unresolved board) pass null.
function isBounded(limit) {
  return Number.isFinite(limit) && limit > 0;
}

async function getActiveAlertGroupsWithMedia({ limit = 2000 } = {}) {
  const bounded = isBounded(limit);
  const result = await query(
    `SELECT g.*
     FROM alert_groups g
     WHERE g.resolved = FALSE
     ORDER BY g.last_alert_ts DESC NULLS LAST
     ${bounded ? 'LIMIT $1' : ''}`,
    bounded ? [limit] : []
  );
  return result.rows;
}

async function getActiveAlertGroupsAll({ limit = 2000 } = {}) {
  const bounded = isBounded(limit);
  const result = await query(
    `SELECT g.*
     FROM alert_groups g
     WHERE g.resolved = FALSE
     ORDER BY g.last_alert_ts DESC NULLS LAST
     ${bounded ? 'LIMIT $1' : ''}`,
    bounded ? [limit] : []
  );
  return result.rows;
}

// Status-filtered listing backing GET /alerts (the frontend asks for
// ?status=new / resolved / closed / active). `limit` null => no LIMIT.
async function listAlertGroups({ status = '', limit = null, offset = 0 } = {}) {
  const s = String(status || '').trim().toLowerCase();
  const where = [];
  if (s === 'active' || s === 'open') {
    where.push('g.resolved = FALSE');
  } else if (s === 'new') {
    where.push('g.resolved = FALSE', "g.status = 'new'");
  } else if (s === 'resolved' || s === 'closed') {
    where.push('g.resolved = TRUE');
  }

  const wantsResolved = where.length === 0 || s === 'resolved' || s === 'closed';
  const bounded = isBounded(limit);
  const offsetN = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = bounded ? `LIMIT $1` : '';
  const offsetSql = offsetN > 0 ? (bounded ? `OFFSET $2` : `OFFSET $1`) : '';
  const params = bounded ? [limit] : [];
  if (offsetN > 0) params.push(offsetN);

  // Resolved rows take their documents from the original alert (alert_groups
  // documents are only the group's own); active rows have no media join today
  // (see getActiveAlertGroupsWithMedia) so keep them on the cheap path.
  const query_ = wantsResolved
    ? `SELECT g.*, COALESCE(a.documents, g.documents) AS documents,
              jsonb_agg(DISTINCT jsonb_build_object(
                'id', m.id, 'file_url', m.file_url, 'file_type', m.file_type,
                'file_size', m.file_size, 'created_at', m.created_at
              )) FILTER (WHERE m.id IS NOT NULL) AS media
       FROM alert_groups g
       LEFT JOIN alerts a ON a.id = g.last_alert_id
       LEFT JOIN alert_media m ON m.alert_id = g.last_alert_id
       ${whereSql}
       GROUP BY g.id, a.documents
       ORDER BY g.last_alert_ts DESC NULLS LAST, g.updated_at DESC NULLS LAST
       ${limitSql} ${offsetSql}`
    : `SELECT g.*
       FROM alert_groups g
       ${whereSql}
       ORDER BY g.last_alert_ts DESC NULLS LAST
       ${limitSql} ${offsetSql}`;

  const result = await query(query_, params);
  if (!wantsResolved) return result.rows;
  return result.rows.map(r => ({ ...r, media: (r.media || []).filter(m => m.id !== null) }));
}

async function getResolvedAlertGroupsWithMedia({ limit = 2000 } = {}) {
  const bounded = isBounded(limit);
  const result = await query(
    `SELECT g.*, COALESCE(a.documents, g.documents) AS documents,
            jsonb_agg(DISTINCT jsonb_build_object(
              'id', m.id, 'file_url', m.file_url, 'file_type', m.file_type,
              'file_size', m.file_size, 'created_at', m.created_at
            )) FILTER (WHERE m.id IS NOT NULL) AS media
     FROM alert_groups g
     LEFT JOIN alerts a ON a.id = g.last_alert_id
     LEFT JOIN alert_media m ON m.alert_id = g.last_alert_id
     WHERE g.resolved = TRUE
     GROUP BY g.id, a.documents
     ORDER BY g.updated_at DESC NULLS LAST, g.last_alert_ts DESC NULLS LAST
     ${bounded ? 'LIMIT $1' : ''}`,
    bounded ? [limit] : []
  );
  return result.rows.map(r => ({
    ...r,
    media: (r.media || []).filter(m => m.id !== null)
  }));
}

async function resolveAlertGroupById(id, updates) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
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
  if (updates.notes !== undefined && updates.notes !== null && String(updates.notes).trim() !== '') {
    sets.push(`notes = $${idx++}`);
    params.push(updates.notes);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  if (updates.documents !== undefined) {
    sets.push(`documents = $${idx++}`);
    // JSONB: pg sends JS arrays as Postgres array literals, which jsonb rejects.
    params.push(
      typeof updates.documents === 'string' ? updates.documents : JSON.stringify(updates.documents),
    );
  }
  if (updates.follow_up !== undefined) {
    sets.push(`follow_up = $${idx++}`);
    params.push(updates.follow_up);
  }
  if (updates.follow_up_at !== undefined) {
    sets.push(`follow_up_at = $${idx++}`);
    params.push(updates.follow_up_at);
  }
  if (updates.original_severity !== undefined) {
    sets.push(`original_severity = $${idx++}`);
    params.push(updates.original_severity);
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = NOW()`);
  params.push(n);
  const result = await query(
    `UPDATE alert_groups SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function appendAlertGroupDocument(id, document) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const result = await query(
    `UPDATE alert_groups
     SET documents = CASE
       WHEN jsonb_array_length(documents) < 100 THEN documents || $1::jsonb
       ELSE documents
     END,
     updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [JSON.stringify(document), n]
  );
  return result.rows[0] || null;
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
  if (updates.follow_up !== undefined) {
    sets.push(`follow_up = $${idx++}`);
    params.push(updates.follow_up);
  }
  if (updates.follow_up_at !== undefined) {
    sets.push(`follow_up_at = $${idx++}`);
    params.push(updates.follow_up_at);
  }
  if (updates.original_severity !== undefined) {
    sets.push(`original_severity = $${idx++}`);
    params.push(updates.original_severity);
  }
  sets.push(`updated_at = NOW()`);

  params.push(groupKey.toLowerCase());
  const result = await query(
    `UPDATE alert_groups SET ${sets.join(', ')} WHERE group_key = $${idx} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function getResolvedAlertGroupCount() {
  const result = await query('SELECT COUNT(*) FROM alert_groups WHERE resolved = TRUE');
  return parseInt(result.rows[0].count);
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
  getActiveAlertGroupsAll,
  getActiveAlertGroupsWithMedia,
  getResolvedAlertGroupsWithMedia,
  getResolvedAlertGroupCount,
  resolveAlertGroup,
  resolveAlertGroupById,
  appendAlertGroupDocument,
  getAlertGroupStats,
  listAlertGroups,
};
