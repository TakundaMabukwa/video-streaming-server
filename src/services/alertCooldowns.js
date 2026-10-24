const { query } = require('../db/pool');

/**
 * Alert cooldowns: while a timer runs for one (vehicle, alert type), NEW
 * alert_groups for that pair are diverted into the backup mirrors instead of
 * the board. Purely additive — with no alert_cooldowns row every call here is
 * a single indexed lookup that returns null and the caller proceeds exactly as
 * before. Key: (device_id, lower(alarm_type)) — set on resolve, 0 minutes
 * deletes, max 720 (12h), expiry is evaluated at query time (no sweeper).
 */

const MAX_COOLDOWN_MINUTES = 720;

// Active cooldown for the pair, or null (also null on lookup failure — a broken
// cooldown check must never drop today's alert creation behaviour).
async function getActiveCooldown(deviceId, alarmType) {
  if (!deviceId || !alarmType) return null;
  try {
    const r = await query(
      `SELECT id, device_id, alarm_type, cooldown_minutes, cooldown_until, alert_group_id, set_by
         FROM alert_cooldowns
        WHERE device_id = $1
          AND lower(alarm_type) = lower($2)
          AND cooldown_until > NOW()
        LIMIT 1`,
      [String(deviceId), String(alarmType)]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error('[COOLDOWN] lookup failed:', err.message);
    return null;
  }
}

// minutes = 0  → delete any cooldown for the pair (operator chose "none").
// minutes > 0  → upsert cooldown_until = NOW() + minutes (clamped to 12h).
async function setCooldown({ deviceId, alarmType, minutes, groupId = null, by = null }) {
  if (!deviceId || !alarmType) return { ok: false, error: 'deviceId and alarmType are required' };
  const parsed = Number(minutes);
  const mins = Number.isFinite(parsed)
    ? Math.max(0, Math.min(MAX_COOLDOWN_MINUTES, Math.floor(parsed)))
    : 0;

  if (mins === 0) {
    await query(
      'DELETE FROM alert_cooldowns WHERE device_id = $1 AND lower(alarm_type) = lower($2)',
      [String(deviceId), String(alarmType)]
    );
    return { ok: true, minutes: 0, until: null };
  }

  const r = await query(
    `INSERT INTO alert_cooldowns (device_id, alarm_type, cooldown_minutes, cooldown_until, alert_group_id, set_by)
     VALUES ($1, $2, $3, NOW() + make_interval(mins => $4), $5, $6)
     ON CONFLICT (device_id, lower(alarm_type)) DO UPDATE
       SET cooldown_minutes = EXCLUDED.cooldown_minutes,
           cooldown_until   = EXCLUDED.cooldown_until,
           alert_group_id   = EXCLUDED.alert_group_id,
           set_by           = EXCLUDED.set_by,
           updated_at       = NOW()
     RETURNING id, cooldown_minutes, cooldown_until`,
    [String(deviceId), String(alarmType), mins, mins, groupId ? Number(groupId) : null, by || null]
  );
  return {
    ok: true,
    minutes: r.rows[0].cooldown_minutes,
    until: r.rows[0].cooldown_until,
  };
}

/**
 * Store one suppressed occurrence: the backup GROUP row (aggregated exactly
 * like alert_groups — count++, latest timestamp/position) plus one backup
 * MEMBER row for the event itself. groupLike/memberLike use the same field
 * names as the live tables write paths.
 */
async function recordSuppressed(cooldown, groupLike = {}, memberLike = null) {
  if (!cooldown || !cooldown.id) return null;
  const g = groupLike || {};
  const deviceId = g.deviceId || cooldown.device_id;
  const alarmType = g.alarmType || cooldown.alarm_type;
  if (!deviceId || !alarmType) return null;

  const groupKey = `cool:${cooldown.id}:${deviceId}:${alarmType}`.toLowerCase();
  const groupRow = await query(
    `INSERT INTO alert_cooldown_groups
       (cooldown_id, group_key, device_id, device_name, alarm_type, alarm_text, count,
        last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number, status)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $13, $14, 'new')
     ON CONFLICT (cooldown_id, device_id, alarm_type) DO UPDATE SET
       count = alert_cooldown_groups.count + 1,
       last_alert_id  = COALESCE(EXCLUDED.last_alert_id, alert_cooldown_groups.last_alert_id),
       last_alert_ts  = GREATEST(
                          COALESCE(EXCLUDED.last_alert_ts,  alert_cooldown_groups.last_alert_ts),
                          COALESCE(alert_cooldown_groups.last_alert_ts, EXCLUDED.last_alert_ts)),
       device_name    = COALESCE(NULLIF(EXCLUDED.device_name, ''), alert_cooldown_groups.device_name),
       alarm_text     = COALESCE(NULLIF(EXCLUDED.alarm_text, ''),  alert_cooldown_groups.alarm_text),
       lat            = COALESCE(EXCLUDED.lat,  alert_cooldown_groups.lat),
       lon            = COALESCE(EXCLUDED.lon,  alert_cooldown_groups.lon),
       speed          = COALESCE(EXCLUDED.speed, alert_cooldown_groups.speed),
       severity       = COALESCE(NULLIF(EXCLUDED.severity, ''), alert_cooldown_groups.severity),
       fleet_number   = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alert_cooldown_groups.fleet_number),
       suppressed_at  = NOW(),
       updated_at     = NOW()
     RETURNING id, count`,
    [
      cooldown.id, groupKey, deviceId, g.deviceName || null, alarmType, g.alarmText || null,
      g.alertId || null, g.alarmTs || null,
      g.lat ?? null, g.lon ?? null, g.speed ?? null,
      g.sourceType || 'video', g.severity || null, g.fleetNumber || null,
    ]
  );

  if (memberLike && memberLike.id) {
    await query(
      `INSERT INTO alert_cooldown_members
         (id, cooldown_id, device_id, device_name, alarm_type, alarm_text, alarm_ts,
          lat, lon, speed, severity, fleet_number, source_type, serial_no, fence_id, alarm_extension)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO NOTHING`,
      [
        String(memberLike.id), cooldown.id,
        memberLike.deviceId || deviceId, memberLike.deviceName || null,
        memberLike.alarmType || alarmType, memberLike.alarmText || null,
        memberLike.alarmTs || null,
        memberLike.lat ?? null, memberLike.lon ?? null, memberLike.speed ?? null,
        memberLike.severity || null, memberLike.fleetNumber || null,
        memberLike.sourceType || 'video',
        memberLike.serialNo || null, memberLike.fenceId || null, memberLike.alarmExtension || null,
      ]
    ).catch((err) => console.error('[COOLDOWN] member store failed:', err.message));
  }

  return groupRow.rows[0] || null;
}

module.exports = { getActiveCooldown, setCooldown, recordSuppressed, MAX_COOLDOWN_MINUTES };
