// Combo groups: AND-combination alert triggers.
//
// A group config with combo_enabled = TRUE stops behaving as a passive grouping.
// Its member alert types are held back individually (staged in alert_combo_events)
// and only surface as ONE merged alert_groups row once EVERY member has fired
// for the same vehicle inside the group's window.
//
// Members are linked to the merged group via alerts.alert_group_id, which is
// exactly how a single alert links its members today — so the board, the
// timeline expander, media, NCR and the closure trigger all work unchanged.

const { query, getClient } = require('./pool');

// One staging row per (combo, detection). Never overwrites an already-linked or
// expired row, so a detection that has been consumed never re-enters a combo.
async function stageComboEvent({ comboId, alertId, deviceId, alarmType, alarmTs }) {
  if (!comboId || !alertId || !deviceId || !alarmType) return null;
  const result = await query(
    `INSERT INTO alert_combo_events (combo_group_config_id, alert_id, device_id, alarm_type, alarm_ts, state)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (combo_group_config_id, alert_id) DO NOTHING
     RETURNING id, state`,
    [comboId, alertId, deviceId, alarmType, alarmTs || null]
  );
  return result.rows[0] || null;
}

// The member definition names still missing for this combo + vehicle inside the
// window. Empty array => every member has fired => the combo is complete.
async function listMissingMembers(comboId, deviceId, memberNames, windowSeconds) {
  const names = (memberNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (names.length === 0) return [];
  const result = await query(
    `SELECT DISTINCT alarm_type
     FROM alert_combo_events
     WHERE combo_group_config_id = $1
       AND device_id = $2
       AND state = 'pending'
       AND alarm_ts >= NOW() - ($3 || ' seconds')::interval`,
    [comboId, deviceId, Math.max(30, Number(windowSeconds) || 300)]
  );
  const seen = new Set(result.rows.map((r) => String(r.alarm_type || '').trim()));
  return names.filter((n) => !seen.has(n));
}

// Every pending staging row for this combo + vehicle inside the window, oldest
// first — these are the detections the merged group will own.
async function listPendingForComboDevice(comboId, deviceId, windowSeconds) {
  const result = await query(
    `SELECT ce.id, ce.alert_id, ce.alarm_type, ce.alarm_ts,
            a.device_id, a.device_name, a.alarm_text, a.lat, a.lon, a.speed,
            a.severity, a.fleet_number, a.source_type
     FROM alert_combo_events ce
     JOIN alerts a ON a.id = ce.alert_id
     WHERE ce.combo_group_config_id = $1
       AND ce.device_id = $2
       AND ce.state = 'pending'
       AND ce.alarm_ts >= NOW() - ($3 || ' seconds')::interval
     ORDER BY ce.alarm_ts ASC NULLS LAST, ce.id ASC`,
    [comboId, deviceId, Math.max(30, Number(windowSeconds) || 300)]
  );
  return result.rows;
}

// Marks every alert row held back by a combo as pending so no list can surface
// it. Rows already linked to a group are never touched.
async function markAlertsPending(alertIds) {
  const ids = (alertIds || []).filter(Boolean);
  if (ids.length === 0) return;
  await query(
    `UPDATE alerts SET combo_state = 'pending', updated_at = NOW()
     WHERE id = ANY($1::text[]) AND combo_state IS DISTINCT FROM 'pending'`,
    [ids]
  );
}

// Create the single merged alert_groups row for a completed combo.
// alarm_type carries the combo name, so the card title, the lane (severity is
// explicit) and the NCR all read naturally. group_key follows the same shape as
// a normal group so the live-row dedup index keeps working.
async function createMergedComboGroup({ deviceId, deviceName, combo, members, lastAlertId, lastAlertTs }) {
  const memberList = members || [];
  if (memberList.length === 0) return null;

  const baseKey = `${deviceId}:combo${combo.id}`.toLowerCase();
  const labels = Array.from(new Set(memberList.map((m) => String(m.alarm_type || '').trim()).filter(Boolean)));
  const alarmText = `${combo.name} — ${labels.join(' + ')}`;

  const fleetNumber =
    memberList.map((m) => String(m.fleet_number || '').trim()).find(Boolean) || null;
  const sourceType = String(combo.source_type || memberList[0]?.source_type || 'video');
  const lat = memberList.find((m) => m.lat != null)?.lat ?? null;
  const lon = memberList.find((m) => m.lon != null)?.lon ?? null;
  const speed = memberList.find((m) => m.speed != null)?.speed ?? null;

  // Reuse the vehicle's open combo group for this combo when there is one, so
  // repeated bursts count up instead of stacking duplicate cards.
  const active = await query(
    `SELECT group_key FROM alert_groups
     WHERE device_id = $1 AND alarm_type = $2 AND source_type = $3
       AND resolved = FALSE AND false_alert = FALSE
     ORDER BY last_alert_ts DESC NULLS LAST
     LIMIT 1`,
    [deviceId, combo.name, sourceType]
  );

  if (active.rows.length > 0) {
    const updated = await query(
      `UPDATE alert_groups SET
         count = alert_groups.count + 1,
         last_alert_id = $1,
         last_alert_ts = $2,
         alarm_text = $3,
         lat = COALESCE($4, alert_groups.lat),
         lon = COALESCE($5, alert_groups.lon),
         speed = COALESCE($6, alert_groups.speed),
         severity = COALESCE(NULLIF($7, ''), alert_groups.severity),
         fleet_number = COALESCE(NULLIF($8, ''), alert_groups.fleet_number),
         updated_at = NOW()
       WHERE group_key = $9
       RETURNING id, group_key, count, alarm_type`,
      [
        lastAlertId || null,
        lastAlertTs || null,
        alarmText,
        lat,
        lon,
        speed ?? null,
        String(combo.severity || 'MEDIUM').toLowerCase(),
        fleetNumber,
        active.rows[0].group_key,
      ]
    );
    return updated.rows[0] || null;
  }

  let groupKey = baseKey;
  const taken = await query('SELECT 1 FROM alert_groups WHERE group_key = $1', [groupKey]);
  if (taken.rows.length > 0) {
    groupKey = `${baseKey}:${Date.now().toString(36)}`;
  }

  const inserted = await query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count,
                               last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (group_key) DO NOTHING
     RETURNING id, group_key, count, device_name, device_id, alarm_type, severity, source_type`,
    [
      groupKey,
      deviceId,
      deviceName || null,
      combo.name,
      alarmText,
      memberList.length,
      lastAlertId || `${deviceId}-combo${combo.id}-${Date.now()}`,
      lastAlertTs || new Date().toISOString(),
      lat,
      lon,
      speed ?? null,
      sourceType,
      String(combo.severity || 'MEDIUM').toLowerCase(),
      fleetNumber,
    ]
  );
  return inserted.rows[0] || null;
}

// Attach every staged member to the merged group and retire the staging rows.
// Also retires this detection's staging rows in OTHER combos: one detection can
// only satisfy one combo, otherwise a single event could raise several cards.
async function linkStagedMembers({ comboId, deviceId, windowSeconds, groupId }) {
  const client = await getClient();
  let linked = [];
  try {
    await client.query('BEGIN');
    const pending = await client.query(
      `SELECT id, alert_id FROM alert_combo_events
       WHERE combo_group_config_id = $1 AND device_id = $2 AND state = 'pending'
         AND alarm_ts >= NOW() - ($3 || ' seconds')::interval
       FOR UPDATE`,
      [comboId, deviceId, Math.max(30, Number(windowSeconds) || 300)]
    );
    const alertIds = pending.rows.map((r) => r.alert_id).filter(Boolean);

    if (alertIds.length > 0) {
      await client.query(
        `UPDATE alerts SET alert_group_id = $1, combo_state = NULL, updated_at = NOW()
         WHERE id = ANY($2::text[])`,
        [groupId, alertIds]
      );
      await client.query(
        `UPDATE alert_combo_events
         SET state = 'linked', alert_group_id = $1, updated_at = NOW()
         WHERE combo_group_config_id = $2 AND alert_id = ANY($3::text[])`,
        [groupId, comboId, alertIds]
      );
      // The same detection must not also complete another combo.
      await client.query(
        `UPDATE alert_combo_events SET state = 'consumed', updated_at = NOW()
         WHERE state = 'pending' AND combo_group_config_id <> $1 AND alert_id = ANY($2::text[])`,
        [comboId, alertIds]
      );
    }
    await client.query('COMMIT');
    linked = alertIds;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return linked;
}

// Retire staging rows whose window has lapsed. Rows are marked, never deleted:
// their media/footage (alert_media / alert_footage cascade on the alerts row)
// stays intact and simply stops being held.
async function sweepExpiredCombos() {
  const expired = await query(
    `UPDATE alert_combo_events ce
     SET state = 'expired', updated_at = NOW()
     WHERE ce.state = 'pending'
       AND ce.alarm_ts < NOW() - (
         SELECT (COALESCE(g.combo_window_seconds, 300) || ' seconds')::interval
         FROM alert_group_configs g
         WHERE g.id = ce.combo_group_config_id
       )
     RETURNING ce.alert_id`
  );
  const alertIds = Array.from(new Set(expired.rows.map((r) => r.alert_id).filter(Boolean)));
  if (alertIds.length > 0) {
    // Only rows with nothing left pending are released back to the normal world.
    await query(
      `UPDATE alerts a SET combo_state = NULL, updated_at = NOW()
       WHERE a.combo_state = 'pending' AND a.id = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM alert_combo_events ce
           WHERE ce.alert_id = a.id AND ce.state = 'pending'
         )`,
      [alertIds]
    );
  }
  return { expired: expired.rowCount, released: alertIds.length };
}

// Members of a combo that are NOT in the given cost centre's alert set. Such a
// member never produces a detection, so the combo can never complete there.
async function listMembersMissingFromCostCenter(comboId, costCenterId) {
  const result = await query(
    `SELECT d.id, d.name
     FROM alert_group_config_members m
     JOIN alert_definitions d ON d.id = m.alert_definition_id
     WHERE m.group_config_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM alert_definition_overrides o
         WHERE o.alert_definition_id = d.id AND o.cost_center_id = $2
           AND o.is_active IS DISTINCT FROM false
       )
     ORDER BY d.name`,
    [comboId, costCenterId]
  );
  return result.rows;
}

module.exports = {
  stageComboEvent,
  listMissingMembers,
  listPendingForComboDevice,
  markAlertsPending,
  createMergedComboGroup,
  linkStagedMembers,
  sweepExpiredCombos,
  listMembersMissingFromCostCenter,
};