const db = require('../db');
const { groupAlert, memberAlert } = require('../helpers/alertDetail');
const { setCooldown } = require('../services/alertCooldowns');

function actorFrom(req, fallback = null) {
  return String(
    req?.user?.email ||
    req?.user?.user_metadata?.email ||
    req?.user?.id ||
    req?.body?.userId ||
    fallback ||
    ''
  ).trim() || null;
}

function intId(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
}

async function getAlertGroupDetail(req, res) {
  try {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Numeric alert group id required' });
    const row = await db.getAlertGroupById(id);
    if (!row) return res.status(404).json({ success: false, message: `Alert group ${id} not found` });
    const latestAlert = row.last_alert_id ? await db.getAlertOccurrence(row.last_alert_id) : null;
    const alert = groupAlert({
      ...row,
      source_device_id: row.source_device_id || latestAlert?.source_device_id || latestAlert?.device_id || null,
      geotab_device_id: row.geotab_device_id || latestAlert?.geotab_device_id || null,
      mettax_device_id: row.mettax_device_id || latestAlert?.mettax_device_id || null,
    });
    return res.json({ success: true, alert, source: 'eps-db' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getOpenAlertsByFleet(req, res) {
  try {
    const fleet = String(req.query?.fleet_number || req.query?.fleet || '').trim();
    if (!fleet) return res.status(400).json({ success: false, message: 'fleet_number is required' });
    const [rows, closedSinceMidnight, closedByType] = await Promise.all([
      db.getOpenAlertGroupsByFleet(fleet),
      db.getClosedAlertGroupCountSinceMidnight(fleet),
      db.getClosedAlertGroupCountsByTypeSinceMidnight(fleet),
    ]);
    const alerts = rows.map((row) => ({
      ...groupAlert({
        ...row,
        source_device_id: row.source_device_id || row.latest_source_device_id || row.latest_alert_device_id || null,
        geotab_device_id: row.geotab_device_id || row.latest_geotab_device_id || null,
        mettax_device_id: row.mettax_device_id || row.latest_mettax_device_id || null,
      }),
      closed_today: closedByType.get(String(row.alarm_type || '').trim().toLowerCase()) || 0,
    }));
    return res.json({
      success: true,
      fleet_number: fleet.toUpperCase(),
      count: alerts.length,
      open_count: alerts.length,
      closed_since_midnight: closedSinceMidnight,
      alerts,
      source: 'eps-db',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertGroupMembers(req, res) {
  try {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Numeric alert group id required' });
    const limit = Math.min(Math.max(parseInt(String(req.query?.limit || '500'), 10) || 500, 1), 2000);
    const [memberResult, group] = await Promise.all([
      db.getGroupMembers(id, { limit }),
      db.getAlertGroupById(id),
    ]);
    const members = memberResult.rows.map(memberAlert);
    return res.json({
      success: true,
      group_id: id,
      group_count: Number(group?.count || 0),
      linked_count: members.length,
      count: members.length,
      truncated: memberResult.truncated,
      members,
      source: 'eps-db',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getAlertOccurrenceDetail(req, res) {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Alert occurrence id required' });
    const row = await db.getAlertOccurrence(id);
    if (!row) return res.status(404).json({ success: false, message: `Alert occurrence ${id} not found` });
    return res.json({ success: true, alert: memberAlert(row), source: 'eps-db' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function resolveAlerts(req, res) {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ success: false, message: 'items must contain at least one alert group' });
    }

    const normalized = [];
    const missingNotes = [];
    for (const item of items) {
      const id = Number(item?.id);
      const notes = String(item?.notes || '').trim();
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ success: false, message: 'Every id must be an integer alert_groups.id' });
      }
      if (!notes) missingNotes.push(id);
      else normalized.push({ id, notes });
    }
    if (missingNotes.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Every selected alert needs a note before resolving.',
        missingNotes,
      });
    }

    const unique = [];
    const seen = new Set();
    for (const item of normalized) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      unique.push(item);
    }

    let cooldownMinutes = null;
    if (body.cooldownMinutes !== undefined && body.cooldownMinutes !== null && body.cooldownMinutes !== '') {
      const n = Number(body.cooldownMinutes);
      if (!Number.isInteger(n) || n < 0 || n > 720) {
        return res.status(400).json({ success: false, message: 'cooldownMinutes must be whole minutes between 0 and 720' });
      }
      cooldownMinutes = n;
    }

    const actor = actorFrom(req);
    const now = new Date().toISOString();
    const resolved = await db.resolveAlertGroupsWithNotes({ items: unique, actor, now });

    let cooldowns = null;
    if (cooldownMinutes !== null && resolved.length > 0) {
      cooldowns = [];
      for (const row of resolved) {
        try {
          const cd = await setCooldown({
            deviceId: row.device_id,
            alarmType: row.alarm_type,
            minutes: cooldownMinutes,
            groupId: row.id,
            by: actor,
          });
          cooldowns.push({ id: row.id, device_id: row.device_id, alarm_type: row.alarm_type, ...cd });
        } catch (err) {
          console.error('[ALERT-CENTER] cooldown failed:', err.message);
        }
      }
    }

    return res.json({
      success: true,
      resolved: resolved.length,
      ids: resolved.map((row) => row.id),
      skipped: unique.length - resolved.length,
      cooldowns,
      source: 'eps-db',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  getAlertGroupDetail,
  getOpenAlertsByFleet,
  getAlertGroupMembers,
  getAlertOccurrenceDetail,
  resolveAlerts,
};
