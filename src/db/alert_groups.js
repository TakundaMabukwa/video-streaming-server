const { query } = require('./pool');
const { isRegisteredVehicle } = require('../services/fleetRegistryGuard');

// Member stamp: link the detection's alert row to its group (insert-or-fill,
// never overwrites member data). Guarded — member linkage must never break
// the hot detection path.
async function stampMember(groupRow, a) {
  if (!groupRow || !groupRow.id || !a || !a.alertId) return groupRow;
  try {
    const { ensureMemberRow } = require('./alerts');
    await ensureMemberRow({
      id: a.alertId,
      deviceId: a.deviceId,
      deviceName: a.deviceName,
      alarmType: a.alarmType,
      alarmText: a.alarmText,
      alarmTs: a.alarmTs || null,
      lat: a.lat ?? null,
      lon: a.lon ?? null,
      speed: a.speed ?? null,
      severity: a.severity || null,
      fleetNumber: a.fleetExact || null,
      sourceType: a.sourceType || 'video',
      groupId: groupRow.id,
    });
  } catch (err) {
    console.error('[GROUPS] member stamp failed:', err.message);
  }
  return groupRow;
}

async function upsertAlertGroup({ deviceId, deviceName, alarmType, alarmText, alertId, alarmTs, lat, lon, speed, sourceType = 'video', severity, fleetNumber, registration }) {
  // Backstop: a vehicle configured to skip this alert must never get a
  // group, whichever detection path tried to create one.
  try {
    const { isSuppressedSync } = require('../services/vehicleAlertOverrides');
    if (isSuppressedSync({
      fleetNumber: fleetNumber || null,
      registration: registration || null,
      alertName: alarmType,
    })) {
      return null;
    }
  } catch (_) { /* never block detection on the override check */ }

  // Only vehicles in fleet_vehicles may raise alerts.
  if (!(await isRegisteredVehicle({ deviceId, deviceName }))) return null;

  const baseKey = `${deviceId}:${alarmType}`.toLowerCase();

  // Authoritative fleet (exact registries only) — stored on every write so
  // reads join on a column, never on parsed names.
  const { resolveFleetExact } = require('../services/costCenterLookup');
  let fleetExact = null;
  try {
    fleetExact = await resolveFleetExact({ deviceId, fleetNumber: null }) || null;
  } catch (_) { fleetExact = null; }

  // Reuse the current LIVE group for this device+type (open AND genuine):
  // bump the counter and refresh the timestamp so the group keeps showing
  // recent time. A resolved or false-alerted row is dead — the event below
  // starts a fresh group instead of resurrecting it.
  const active = await query(
    `SELECT group_key FROM alert_groups
     WHERE device_id = $1 AND alarm_type = $2 AND source_type = $3
       AND resolved = FALSE AND false_alert = FALSE
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
         speed = COALESCE($6, alert_groups.speed),
         alarm_text = COALESCE(NULLIF($7, ''), alert_groups.alarm_text),
         severity = COALESCE(NULLIF($8, ''), alert_groups.severity),
         fleet_number = COALESCE(NULLIF($9, ''), alert_groups.fleet_number),
         updated_at = NOW()
       WHERE group_key = $10
       RETURNING id, group_key, count, alarm_type`,
      [alertId, alarmTs, deviceName, lat, lon, speed ?? null, alarmText, severity, fleetExact || null, groupKey]
    );
    return stampMember(result.rows[0], { alertId, deviceId, deviceName, alarmType, alarmText, alarmTs, lat, lon, speed, severity, fleetExact, sourceType });
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
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (group_key) DO NOTHING
     RETURNING id, group_key, count, alarm_type`,
    [groupKey, deviceId, deviceName, alarmType, alarmText, alertId, alarmTs || null, lat, lon, speed ?? null, sourceType, severity,
     fleetExact || null]
  );
  if (result.rows.length > 0) {
    const row = await stampMember(result.rows[0], { alertId, deviceId, deviceName, alarmType, alarmText, alarmTs, lat, lon, speed, severity, fleetExact, sourceType });
    await requestIncidentFootage(row, { alertId, deviceId, alarmType, alarmTs, fleetExact, deviceName, sourceType });
    return row;
  }
  // Base key lost a race (or is squatted by a dead row): bump-or-insert via
  // the live-row arbiter instead of throwing. Never throws, never twins.
  const raced = await query(
    `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (device_id, alarm_type, source_type) WHERE (resolved = FALSE AND false_alert = FALSE)
     DO UPDATE SET count = alert_groups.count + 1, last_alert_id = EXCLUDED.last_alert_id,
       last_alert_ts = EXCLUDED.last_alert_ts,
       fleet_number = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alert_groups.fleet_number),
       updated_at = NOW()
     RETURNING id, group_key, count, alarm_type`,
    [`${baseKey}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
     deviceId, deviceName, alarmType, alarmText, alertId, alarmTs || null, lat, lon, speed ?? null, sourceType, severity,
     fleetExact || null]
  );
  return stampMember(raced.rows[0] || null, { alertId, deviceId, deviceName, alarmType, alarmText, alarmTs, lat, lon, speed, severity, fleetExact, sourceType });
}

// Collision alerts must have their footage captured. The request is queued
// (never inline) so detection is never slowed down, and it only fires when a
// NEW group is created — a burst of collisions is one incident, one capture.
// The capture itself starts IMMEDIATELY (not on the next runner tick) and the
// queued job only exists to retry it.
async function requestIncidentFootage(groupRow, ctx) {
  try {
    if (!groupRow || !groupRow.id) return;
    const { isFootageAlarmType } = require('../services/alertFootageService');
    if (!isFootageAlarmType(ctx.alarmType)) return;
    const { query: q } = require('./pool');
    const payload = {
      alertId: ctx.alertId,
      alertGroupId: groupRow.id,
      deviceId: ctx.deviceId,
      fleetNumber: ctx.fleetExact || null,
      registration: ctx.deviceName || null,
      alarmType: ctx.alarmType,
      alertTime: ctx.alarmTs || new Date().toISOString(),
    };
    const inserted = await q(
      `INSERT INTO jobs (job_type, payload, alert_group_id, next_retry_at)
       VALUES ('footage', $1::jsonb, $2, NOW() + INTERVAL '60 seconds') RETURNING id`,
      [JSON.stringify(payload), groupRow.id]
    );
    const jobId = inserted.rows[0]?.id;
    if (!jobId) return;

    // Start the capture NOW — the alert's footage must be requested the
    // moment the alert arrives, not on the next 15s sweep. The queued job is
    // only the retry path (it waits 60s so it cannot race this attempt).
    void (async () => {
      try {
        const { captureIncidentFootage } = require('../services/alertFootageService');
        await captureIncidentFootage(payload);
        await q(`UPDATE jobs SET status = 'done', updated_at = NOW() WHERE id = $1`, [jobId]);
      } catch (err) {
        // Let the runner retry it (the camera may only come back later).
        await q(
          `UPDATE jobs SET next_retry_at = NOW(), error = $2, updated_at = NOW() WHERE id = $1`,
          [jobId, String(err.message || err).slice(0, 500)]
        ).catch(() => {});
        console.error('[FOOTAGE] immediate capture failed (the job will retry):', err.message);
      }
    })();
  } catch (err) {
    console.error('[FOOTAGE] could not queue the capture:', err.message);
  }
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

  // Authoritative fleet per entry (exact registries only; null when unknown).
  // Stored on every write so reads join on a column, never on parsed names.
  const { resolveFleetExact } = require('../services/costCenterLookup');
  for (const g of entries) {
    try {
      g.fleetExact = await resolveFleetExact({ deviceId: g.deviceId }) || null;
    } catch (_) { g.fleetExact = null; }
  }

  // Simple rule, live row first: bump the open+genuine row when there is one.
  // Only rows with no live row reach the INSERT below, so it can never trip
  // the live-row unique index — a group_key conflict means a dead base row.
  const result = { rows: [] };
  const pending = [];
  const newGroupKeys = new Set();
  for (const g of entries) {
    const bumped = await query(
      `UPDATE alert_groups SET
         count = alert_groups.count + 1,
         last_alert_id = $1, last_alert_ts = $2,
         device_name = COALESCE(NULLIF($3, ''), alert_groups.device_name),
         lat = COALESCE($4, alert_groups.lat), lon = COALESCE($5, alert_groups.lon),
         speed = COALESCE($6, alert_groups.speed),
         alarm_text = COALESCE(NULLIF($7, ''), alert_groups.alarm_text),
         severity = COALESCE(NULLIF($8, ''), alert_groups.severity),
         fleet_number = COALESCE(NULLIF($9, ''), alert_groups.fleet_number),
         updated_at = NOW()
       WHERE device_id = $10 AND alarm_type = $11 AND source_type = $12
         AND resolved = FALSE AND false_alert = FALSE
       RETURNING id, group_key, count, alarm_type`,
      [g.alertId, g.alarmTs || null, g.deviceName || null, g.lat || null,
       g.lon || null, g.speed ?? null, g.alarmText || null, g.severity || null,
       g.fleetExact || null, g.deviceId, g.alarmType, g.sourceType || 'video']
    );
    if (bumped.rows.length > 0) {
      result.rows.push(bumped.rows[0]);
      await stampMember(bumped.rows[0], { alertId: g.alertId, deviceId: g.deviceId, deviceName: g.deviceName, alarmType: g.alarmType, alarmText: g.alarmText, alarmTs: g.alarmTs, lat: g.lat, lon: g.lon, speed: g.speed, severity: g.severity, fleetExact: g.fleetExact, sourceType: g.sourceType });
    } else pending.push(g);
  }
  if (pending.length === 0) return result.rows;

  const params = [];
  const placeholders = pending.map((g, i) => {
    const base = i * 12;
    params.push(
      `${g.deviceId}:${g.alarmType}`.toLowerCase(),
      g.deviceId, g.deviceName || null, g.alarmType, g.alarmText || null,
      g.alertId, g.alarmTs || null, g.lat || null, g.lon || null, g.speed ?? null, g.severity || null,
      g.fleetExact || null
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 1, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
  }).join(',');
  // Base-key insert: a live row cannot exist here (bumped above), so the only
  // possible conflict is a dead base row — killed by the WHERE, falls through.
  // On the vanishing chance a live row lands between the bump and this
  // insert, the live-index violation is caught below and retried via twins.
  let inserted;
  try {
    inserted = await query(
      `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, speed, severity, fleet_number)
       VALUES ${placeholders}
       ON CONFLICT (group_key) DO UPDATE SET
         count = alert_groups.count + 1,
         last_alert_id = EXCLUDED.last_alert_id,
         last_alert_ts = EXCLUDED.last_alert_ts,
         device_name = COALESCE(NULLIF(EXCLUDED.device_name, ''), alert_groups.device_name),
         lat = COALESCE(EXCLUDED.lat, alert_groups.lat),
         lon = COALESCE(EXCLUDED.lon, alert_groups.lon),
         speed = COALESCE(EXCLUDED.speed, alert_groups.speed),
         alarm_text = COALESCE(NULLIF(EXCLUDED.alarm_text, ''), alert_groups.alarm_text),
         severity = COALESCE(NULLIF(EXCLUDED.severity, ''), alert_groups.severity),
         fleet_number = COALESCE(NULLIF(EXCLUDED.fleet_number, ''), alert_groups.fleet_number),
         updated_at = NOW()
         WHERE alert_groups.resolved = FALSE AND alert_groups.false_alert = FALSE
         RETURNING id, group_key, count, alarm_type`,
      params
    );
  } catch (err) {
    if (err?.code !== '23505') throw err;
    inserted = { rows: [] }; // live row landed mid-flight: twin branch re-bumps
  }

  // Simple rule, enforced by idx_ag_one_open (unique device/type/source while
  // open and genuine): if an open, non-false group exists for the device+type,
  // bump it; otherwise insert. A resolved OR false-alerted row is dead — a new
  // event starts a fresh group. A conflict against a dead base row returns
  // nothing (the WHERE kills it) — fall through to the twin branch. A conflict
  // against the live row bumps it right in the statement, so even a race
  // converges.
  const pendingByBaseKey = new Map(pending.map((g) => [`${g.deviceId}:${g.alarmType}`.toLowerCase(), g]));
  for (const r of inserted.rows) {
    result.rows.push(r);
    const g = pendingByBaseKey.get(String(r.group_key || '').toLowerCase());
    if (g) {
      await stampMember(r, { alertId: g.alertId, deviceId: g.deviceId, deviceName: g.deviceName, alarmType: g.alarmType, alarmText: g.alarmText, alarmTs: g.alarmTs, lat: g.lat, lon: g.lon, speed: g.speed, severity: g.severity, fleetExact: g.fleetExact, sourceType: g.sourceType });
      await requestIncidentFootage(r, { alertId: g.alertId, deviceId: g.deviceId, alarmType: g.alarmType, alarmTs: g.alarmTs, fleetExact: g.fleetExact, deviceName: g.deviceName, sourceType: g.sourceType });
    }
  }
  const settled = new Set(result.rows.map((r) => r.group_key));
  const twins = pending.filter((g) => !settled.has(`${g.deviceId}:${g.alarmType}`.toLowerCase()));
  if (twins.length > 0) {
    const stamp = Date.now().toString(36);
    for (const g of twins) {
      const bumpCols = `count = alert_groups.count + 1,
        last_alert_id = $1, last_alert_ts = $2,
        device_name = COALESCE(NULLIF($3, ''), alert_groups.device_name),
        lat = COALESCE($4, alert_groups.lat), lon = COALESCE($5, alert_groups.lon),
        speed = COALESCE($6, alert_groups.speed),
        alarm_text = COALESCE(NULLIF($7, ''), alert_groups.alarm_text),
        severity = COALESCE(NULLIF($8, ''), alert_groups.severity),
        fleet_number = COALESCE(NULLIF($9, ''), alert_groups.fleet_number),
        updated_at = NOW()`;
      const bumpParams = [g.alertId, g.alarmTs || null, g.deviceName || null, g.lat || null,
        g.lon || null, g.speed ?? null, g.alarmText || null, g.severity || null, g.fleetExact || null];
      // 1. Bump the live row if there is one (open AND genuine — a resolved
      // or false-alerted row is dead and must not absorb new events).
      const bumped = await query(
        `UPDATE alert_groups SET ${bumpCols}
         WHERE device_id = $10 AND alarm_type = $11 AND source_type = $12
           AND resolved = FALSE AND false_alert = FALSE
         RETURNING id, group_key, count, alarm_type`,
        [...bumpParams, g.deviceId, g.alarmType, g.sourceType || 'video']
      );
      if (bumped.rows.length > 0) {
        result.rows.push(bumped.rows[0]);
        continue;
      }
      // 2. No open row: insert. Base key first (reclaims it when free)...
      const baseKey = `${g.deviceId}:${g.alarmType}`.toLowerCase();
      const baseIns = await query(
        `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (group_key) DO NOTHING
         RETURNING id, group_key, count, alarm_type`,
        [baseKey, g.deviceId, g.deviceName || null, g.alarmType, g.alarmText || null,
         g.alertId, g.alarmTs || null, g.lat || null, g.lon || null, g.speed ?? null, g.sourceType || 'video', g.severity || null,
         g.fleetExact || null]
      );
      if (baseIns.rows.length > 0) {
        result.rows.push(baseIns.rows[0]);
        continue;
      }
      // 3. Base squatted by a dead row: mint one twin. The unique live index
      // guarantees this is the only live row — a racer converges via the
      // ON CONFLICT bump instead of a second twin. (Placeholders $14-$22
      // carry the bump values; $1-$13 are the insert row.)
      const freshKey = `${baseKey}:${stamp}` +
        `${g.alertId ? '-' + String(g.alertId).slice(-6) : ''}-${Math.random().toString(36).slice(2, 7)}`;
      const twinBumpCols = `count = alert_groups.count + 1,
        last_alert_id = $14, last_alert_ts = $15,
        device_name = COALESCE(NULLIF($16, ''), alert_groups.device_name),
        lat = COALESCE($17, alert_groups.lat), lon = COALESCE($18, alert_groups.lon),
        speed = COALESCE($19, alert_groups.speed),
        alarm_text = COALESCE(NULLIF($20, ''), alert_groups.alarm_text),
        severity = COALESCE(NULLIF($21, ''), alert_groups.severity),
        fleet_number = COALESCE(NULLIF($22, ''), alert_groups.fleet_number),
        updated_at = NOW()`;
      const twinIns = await query(
        `INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, speed, source_type, severity, fleet_number)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (device_id, alarm_type, source_type) WHERE (resolved = FALSE AND false_alert = FALSE)
         DO UPDATE SET ${twinBumpCols}
         RETURNING id, group_key, count, alarm_type`,
        [freshKey, g.deviceId, g.deviceName || null, g.alarmType, g.alarmText || null,
         g.alertId, g.alarmTs || null, g.lat || null, g.lon || null, g.speed ?? null, g.sourceType || 'video', g.severity || null,
         g.fleetExact || null, ...bumpParams]
      );
      if (twinIns.rows.length > 0) {
        result.rows.push(twinIns.rows[0]);
        await stampMember(twinIns.rows[0], { alertId: g.alertId, deviceId: g.deviceId, deviceName: g.deviceName, alarmType: g.alarmType, alarmText: g.alarmText, alarmTs: g.alarmTs, lat: g.lat, lon: g.lon, speed: g.speed, severity: g.severity, fleetExact: g.fleetExact, sourceType: g.sourceType });
      }
    }
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

// Light board columns: everything the open board and cards need, nothing
// heavy (no documents JSON blobs beyond what cards use, no media joins).
const BOARD_COLUMNS = `g.id, g.group_key, g.device_id, g.device_name, g.alarm_type,
  g.alarm_text, g.count, g.last_alert_id, g.last_alert_ts, g.lat, g.lon, g.speed,
  g.status, g.resolved, g.false_alert, g.resolved_at, g.resolved_by,
  g.source_type, g.severity, g.follow_up, g.follow_up_at, g.original_severity,
  g.created_at, g.updated_at`;

async function getActiveAlertGroupsWithMedia({ limit = 2000 } = {}) {
  const bounded = isBounded(limit);
  const result = await query(
    `SELECT ${BOARD_COLUMNS}
     FROM alert_groups g
     WHERE g.resolved = FALSE AND g.false_alert = FALSE
     ORDER BY g.last_alert_ts DESC NULLS LAST
     ${bounded ? 'LIMIT $1' : ''}`,
    bounded ? [limit] : []
  );
  return result.rows;
}

async function getActiveAlertGroupsAll({ limit = 2000 } = {}) {
  const bounded = isBounded(limit);
  const result = await query(
    `SELECT ${BOARD_COLUMNS}
     FROM alert_groups g
     WHERE g.resolved = FALSE AND g.false_alert = FALSE
     ORDER BY g.last_alert_ts DESC NULLS LAST
     ${bounded ? 'LIMIT $1' : ''}`,
    bounded ? [limit] : []
  );
  return result.rows;
}

// Fast first paint: latest open group per vehicle (device_id). Small result
// (one row per device, not per group) so the board can render instantly and
// hydrate the full 65k set in the background. Uses DISTINCT ON which is
// backed by idx_ag_per_vehicle (device_id, last_alert_ts DESC).
async function getActivePerVehicleGroups() {
  const result = await query(
    `SELECT DISTINCT ON (g.device_id) ${BOARD_COLUMNS}
     FROM alert_groups g
     WHERE g.resolved = FALSE AND g.false_alert = FALSE
       AND g.device_id IS NOT NULL AND g.device_id <> ''
     ORDER BY g.device_id, g.last_alert_ts DESC NULLS LAST`,
    []
  );
  // Board expects recency order, not device_id order.
  result.rows.sort((a, b) => {
    const ta = a.last_alert_ts ? new Date(a.last_alert_ts).getTime() : 0;
    const tb = b.last_alert_ts ? new Date(b.last_alert_ts).getTime() : 0;
    return tb - ta;
  });
  return result.rows;
}

// Cursor-paginated full-board hydration: avoids one unbounded 65k-row flush
// (30s socket timeout + gzip CPU spike). Keyset on (last_alert_ts, id).
// cursorTs ISO string, cursorId integer; both null on first page.
async function getActiveAlertGroupsPage({ limit = 10000, cursorTs = null, cursorId = null } = {}) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), 20000) : 10000;
  const params = [];
  let cursorSql = '';
  if (cursorTs) {
    params.push(cursorTs);
    if (cursorId != null && Number.isFinite(Number(cursorId))) {
      params.push(Number(cursorId));
      cursorSql = `AND ((g.last_alert_ts < $1::timestamptz) OR (g.last_alert_ts = $1::timestamptz AND g.id < $2))`;
    } else {
      cursorSql = `AND (g.last_alert_ts < $1::timestamptz)`;
    }
  }
  params.push(n + 1); // fetch one extra to detect hasMore
  const limitIdx = params.length;
  const result = await query(
    `SELECT ${BOARD_COLUMNS}
     FROM alert_groups g
     WHERE g.resolved = FALSE AND g.false_alert = FALSE
     ${cursorSql}
     ORDER BY g.last_alert_ts DESC NULLS LAST, g.id DESC
     LIMIT $${limitIdx}`,
    params
  );
  const hasMore = result.rows.length > n;
  const rows = hasMore ? result.rows.slice(0, n) : result.rows;
  const last = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursorTs: hasMore && last ? last.last_alert_ts : null,
    nextCursorId: hasMore && last ? last.id : null,
  };
}

// Minimal rows for the fast header-counts endpoint. Same open set as the
// board list (resolved=FALSE AND false_alert=FALSE) but only the columns the
// CC filter + escalation math need — no payload, no transform.
async function getActiveAlertCountRows() {
  const result = await query(
    `SELECT device_id, device_name, alarm_type, source_type, severity, count, follow_up, follow_up_at, last_alert_ts
     FROM alert_groups
     WHERE resolved = FALSE AND false_alert = FALSE`
  );
  return result.rows;
}

// Delta polling: groups changed since a cursor. The board loads the full
// (unbounded) list once, then polls this — single-digit rows instead of 65k.
// `since` should overlap ~30s (client sends lastAsOf - 30s); id-keyed merge
// dedupes the overlap. Tombstones (resolved since cursor) come from
// getResolvedSince below.
async function getActiveAlertChanges({ since }) {
  const result = await query(
    `SELECT ${BOARD_COLUMNS}
     FROM alert_groups g
     WHERE g.resolved = FALSE AND g.false_alert = FALSE
       AND g.updated_at > $1::timestamptz
     ORDER BY g.updated_at ASC`,
    [since]
  );
  return result.rows;
}

// Ids resolved since a cursor — lets delta clients drop cards without a
// full reload. Resolved groups never reappear (resolve sticks), so a
// tombstone is final for that group id.
async function getResolvedSince({ since }) {
  const result = await query(
    `SELECT id, resolved_at FROM alert_groups
     WHERE resolved = TRUE AND COALESCE(resolved_at, updated_at) > $1::timestamptz
     ORDER BY COALESCE(resolved_at, updated_at) ASC
     LIMIT 5000`,
    [since]
  );
  return result.rows;
}

// Compact serialization: shared column header + positional rows. Kills the
// ~60% of list payload that is repeated JSON key names (measured 37.6MB →
// ~15MB pre-gzip on 65k rows). Shape-preserving: unpack(columns, rows)
// rebuilds identical objects.
function packAlerts(alerts) {
  if (!alerts || alerts.length === 0) return { columns: [], rows: [] };
  const columns = Object.keys(alerts[0]);
  return { columns, rows: alerts.map((a) => columns.map((c) => a[c] ?? null)) };
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

async function getResolvedAlertGroupsWithMedia({ limit = 2000, from = null, to = null } = {}) {
  const bounded = isBounded(limit);
  const params = [];
  const where = ['g.resolved = TRUE'];
  if (from) {
    params.push(from);
    where.push(`COALESCE(g.updated_at, g.last_alert_ts) >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to);
    where.push(`COALESCE(g.updated_at, g.last_alert_ts) <= $${params.length}::timestamptz`);
  }
  if (bounded) params.push(limit);
  const result = await query(
    `SELECT g.*, COALESCE(a.documents, g.documents) AS documents,
            jsonb_agg(DISTINCT jsonb_build_object(
              'id', m.id, 'file_url', m.file_url, 'file_type', m.file_type,
              'file_size', m.file_size, 'created_at', m.created_at
            )) FILTER (WHERE m.id IS NOT NULL) AS media
     FROM alert_groups g
     LEFT JOIN alerts a ON a.id = g.last_alert_id
     LEFT JOIN alert_media m ON m.alert_id = g.last_alert_id
     WHERE ${where.join(' AND ')}
     GROUP BY g.id, a.documents
     ORDER BY g.updated_at DESC NULLS LAST, g.last_alert_ts DESC NULLS LAST
     ${bounded ? `LIMIT $${params.length}` : ''}`,
    params
  );
  return result.rows.map(r => ({
    ...r,
    media: (r.media || []).filter(m => m.id !== null)
  }));
}

// Closed-alert summary for the Alert Stats page: genuine resolved alerts
// (resolved=TRUE AND false_alert=FALSE) in a day window, aggregated by cost
// center with top vehicles/drivers nested. All aggregation happens in SQL so
// the 65k+ closed set never ships row-by-row. Fleet/CC resolution mirrors
// costCenterLookup (first token of device_name, UPPER match) — approximate by
// design; rows that resolve nowhere land in the Unassigned (null) bucket.
// Driver is point-in-time from driver_scoring (no historical attribution).
async function getClosedSummaryByCC({ days = 30, sourceType = null, topN = 8 } = {}) {
  const d = Number.isFinite(Number(days)) ? Math.min(Math.max(Math.floor(Number(days)), 1), 365) : 30;
  const n = Number.isFinite(Number(topN)) ? Math.min(Math.max(Math.floor(Number(topN)), 1), 50) : 8;
  const params = [d];
  let sourceSql = '';
  if (sourceType === 'video' || sourceType === 'telematics') {
    params.push(sourceType);
    sourceSql = `AND g.source_type = $2`;
  }
  const base = `
    WITH closed AS (
      SELECT g.device_id, g.device_name, g.alarm_type, g.severity, g.count,
             g.last_alert_ts, g.source_type,
             UPPER(SPLIT_PART(COALESCE(NULLIF(TRIM(g.device_name), ''), g.device_id, ''), ' - ', 1)) AS fleet_guess
      FROM alert_groups g
      WHERE g.resolved = TRUE AND g.false_alert = FALSE
        AND COALESCE(g.updated_at, g.last_alert_ts) > NOW() - ($1 || ' days')::INTERVAL
        ${sourceSql}
    ),
    resolved AS (
      SELECT c.*,
             COALESCE(ds.cost_center_id, fv.cost_center_id) AS cc_id,
             COALESCE(ds.fleet_number, fv.fleet_number, c.fleet_guess) AS fleet,
             COALESCE(ds.registration_number, fv.registration_number) AS registration,
             ds.driver AS driver
      FROM closed c
      LEFT JOIN driver_scoring ds ON UPPER(ds.fleet_number) = c.fleet_guess
      LEFT JOIN fleet_vehicles fv ON UPPER(fv.fleet_number) = c.fleet_guess
    )`;
  const perCC = await query(
    `${base}
    SELECT r.cc_id, cc.name AS cc_name,
           COUNT(*) AS groups, COALESCE(SUM(r.count), 0) AS alerts,
           COUNT(DISTINCT r.fleet) AS vehicles,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(r.severity, 'medium')) = 'critical') AS critical,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(r.severity, 'medium')) = 'high') AS high,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(r.severity, 'medium')) = 'medium') AS medium,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(r.severity, 'medium')) = 'low') AS low,
           MAX(r.last_alert_ts) AS last_seen
    FROM resolved r
    LEFT JOIN cost_centers cc ON cc.id = r.cc_id
    GROUP BY r.cc_id, cc.name
    ORDER BY alerts DESC`,
    params
  );
  const tops = await query(
    `${base},
    ranked_vehicles AS (
      SELECT r.cc_id, r.fleet AS fleet,
             MAX(r.registration) AS registration, MAX(r.driver) AS driver,
             COALESCE(SUM(r.count), 0) AS alerts, COUNT(*) AS groups,
             MAX(r.last_alert_ts) AS last_seen,
             ROW_NUMBER() OVER (PARTITION BY r.cc_id ORDER BY COALESCE(SUM(r.count), 0) DESC) AS rn
      FROM resolved r
      GROUP BY r.cc_id, r.fleet
    ),
    ranked_drivers AS (
      SELECT r.cc_id, COALESCE(NULLIF(TRIM(r.driver), ''), 'Unknown') AS driver,
             MAX(r.fleet) AS fleet, MAX(r.registration) AS registration,
             COALESCE(SUM(r.count), 0) AS alerts, COUNT(*) AS groups,
             MAX(r.last_alert_ts) AS last_seen,
             ROW_NUMBER() OVER (PARTITION BY r.cc_id ORDER BY COALESCE(SUM(r.count), 0) DESC) AS rn
      FROM resolved r
      GROUP BY r.cc_id, COALESCE(NULLIF(TRIM(r.driver), ''), 'Unknown')
    )
    (SELECT 'vehicle' AS kind, cc_id, fleet, registration, driver, alerts, groups, last_seen
     FROM ranked_vehicles WHERE rn <= ${n})
    UNION ALL
    (SELECT 'driver' AS kind, cc_id, fleet, registration, driver, alerts, groups, last_seen
     FROM ranked_drivers WHERE rn <= ${n})
    ORDER BY cc_id, kind, alerts DESC`,
    params
  );
  return { perCC: perCC.rows, tops: tops.rows };
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
  getActiveAlertCountRows,
  getActiveAlertChanges,
  getResolvedSince,
  packAlerts,
  getAlertGroupById,
  getAlertGroupByKey,
  getAlertGroupByAlertId,
  getActiveAlertGroupsAll,
  getActiveAlertGroupsWithMedia,
  getActivePerVehicleGroups,
  getActiveAlertGroupsPage,
  getClosedSummaryByCC,
  getResolvedAlertGroupsWithMedia,
  getResolvedAlertGroupCount,
  resolveAlertGroup,
  resolveAlertGroupById,
  appendAlertGroupDocument,
  getAlertGroupStats,
  listAlertGroups,
};
