// Alert combos: AND-combination triggers built on alert_group_configs.
//
// A group config with combo_enabled = TRUE stops being a passive grouping. Its
// member alert types are held back individually and only surface as ONE merged
// alert once EVERY member has fired for the same vehicle inside the group's
// window. Members are linked through alerts.alert_group_id exactly like a single
// alert, so the board, timeline, media, NCR and closure all work unchanged.
//
// Scope follows the same STRICT COST-CENTRE RULE as alert_definitions.js: a
// vehicle in a cost centre only sees a combo when an active
// alert_group_config_overrides row puts that group in the CC's set; a vehicle
// with no cost centre uses the global group.

const db = require('../db');
const {
  stageComboEvent,
  listMissingMembers,
  listPendingForComboDevice,
  markAlertsPending,
  createMergedComboGroup,
  linkStagedMembers,
  sweepExpiredCombos,
} = require('../db/combo_groups');
const { ensureMemberRow } = require('../db/alerts');

const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_WINDOW_SECONDS = 30;
const DEFAULT_WINDOW_SECONDS = 300;

let cachedIndex = null; // memberName(lowercase) -> combo[]
let cachedAt = 0;

function invalidate() {
  cachedIndex = null;
  cachedAt = 0;
}

// Loads every enabled combo with its members and the cost centres it is in the
// set of. A definition may belong to MANY combos, so the index is many-to-many.
async function loadComboIndex() {
  const now = Date.now();
  if (cachedIndex && now - cachedAt < CACHE_TTL_MS) return cachedIndex;

  try {
    const [groupRes, memberRes] = await Promise.all([
      db.query(
        `SELECT g.id, g.name, g.severity, g.description, g.combo_window_seconds,
                o.cost_center_id, o.severity AS override_severity, o.description AS override_description
         FROM alert_group_configs g
         LEFT JOIN alert_group_config_overrides o
           ON o.group_config_id = g.id AND o.is_active IS DISTINCT FROM false
         WHERE g.combo_enabled = TRUE AND g.is_active IS DISTINCT FROM false`
      ),
      db.query(
        `SELECT m.group_config_id, d.name, d.is_active
         FROM alert_group_config_members m
         JOIN alert_definitions d ON d.id = m.alert_definition_id
         WHERE d.is_active IS DISTINCT FROM false`
      ),
    ]);

    const combos = new Map();
    for (const row of groupRes.rows) {
      if (!combos.has(row.id)) {
        combos.set(row.id, {
          id: row.id,
          name: String(row.name || '').trim(),
          baseSeverity: String(row.severity || 'MEDIUM').toUpperCase(),
          windowSeconds: Math.max(
            MIN_WINDOW_SECONDS,
            Number(row.combo_window_seconds) || DEFAULT_WINDOW_SECONDS
          ),
          members: [],
          ccOverrides: new Map(),
        });
      }
      const combo = combos.get(row.id);
      if (row.cost_center_id != null) {
        combo.ccOverrides.set(Number(row.cost_center_id), {
          severity: String(
            row.override_severity || combo.baseSeverity
          ).toUpperCase(),
          description: row.override_description ?? null,
        });
      }
    }

    for (const row of memberRes.rows) {
      const combo = combos.get(row.group_config_id);
      if (!combo) continue;
      combo.members.push(String(row.name || '').trim());
    }

    // Drop combos that can never complete (fewer than two usable members) and
    // index everything by member name (lowercase) for the hot-path lookup.
    const index = {};
    for (const combo of combos.values()) {
      const memberNames = Array.from(new Set(combo.members.filter(Boolean)));
      if (memberNames.length < 2) continue;
      combo.memberNames = memberNames;
      for (const name of memberNames) {
        const key = name.toLowerCase();
        if (!index[key]) index[key] = [];
        index[key].push(combo);
      }
    }

    cachedIndex = index;
    cachedAt = now;
    return index;
  } catch (err) {
    console.error('[COMBOS] failed to load combo index:', err.message);
    return cachedIndex || {};
  }
}

// Enabled combos that list this alert type and apply to the vehicle's cost
// centre. Returns [] whenever the caller should behave exactly as before.
async function findCombosForMember(alarmType, costCenterId) {
  const name = String(alarmType || '').trim();
  if (!name) return [];
  const index = await loadComboIndex();
  const candidates = index[name.toLowerCase()] || [];
  if (candidates.length === 0) return [];

  const ccId = costCenterId == null || costCenterId === '' ? null : Number(costCenterId);
  return candidates
    .filter((combo) => {
      // A cost-centre vehicle only sees combos in its own set; a CC-less
      // vehicle uses the global group (mirrors the definitions rule).
      if (ccId == null) return true;
      return combo.ccOverrides.has(ccId);
    })
    .map((combo) => {
      const override = ccId == null ? null : combo.ccOverrides.get(ccId);
      return {
        id: combo.id,
        name: combo.name,
        severity: (override && override.severity) || combo.baseSeverity,
        description: (override && override.description) || null,
        windowSeconds: combo.windowSeconds,
        memberNames: combo.memberNames,
      };
    });
}

/**
 * Gate one detection through the combo layer.
 *
 * ctx: { alertId, deviceId, deviceName, alarmType, alarmText, alarmTs,
 *        lat, lon, speed, severity, fleetNumber, sourceType, costCenterId }
 *
 * Returns one of:
 *   { action: 'pass',   groupRows: [] }  -> not part of any combo; caller runs
 *                                          the normal upsertAlertGroup path.
 *   { action: 'staged', groupRows: [] }  -> held back; a combo is still waiting
 *                                          for its other members. Nothing is
 *                                          shown on the board.
 *   { action: 'raised', groupRows: [..] } -> one or more combos completed and
 *                                          their merged groups already exist.
 *                                          groupRows are ready to broadcast.
 */
async function handleDetection(ctx) {
  const deviceId = String(ctx.deviceId || '').trim();
  const alarmType = String(ctx.alarmType || '').trim();
  const alertId = String(ctx.alertId || '').trim();
  if (!deviceId || !alarmType || !alertId) {
    return { action: 'pass', groupRows: [] };
  }

  const combos = await findCombosForMember(alarmType, ctx.costCenterId);
  if (combos.length === 0) {
    return { action: 'pass', groupRows: [] };
  }

  const groupRows = [];
  let staged = false;

  for (const combo of combos) {
    // The detection itself is always stored: media, footage and the member
    // list all key off the alerts row, exactly as they do for a single alert.
    try {
      await ensureMemberRow({
        id: alertId,
        deviceId,
        deviceName: ctx.deviceName,
        alarmType,
        alarmText: ctx.alarmText,
        alarmTs: ctx.alarmTs || null,
        lat: ctx.lat ?? null,
        lon: ctx.lon ?? null,
        speed: ctx.speed ?? null,
        severity: ctx.severity || null,
        fleetNumber: ctx.fleetNumber || null,
        sourceType: ctx.sourceType || 'video',
        groupId: null,
      });
    } catch (err) {
      console.error('[COMBOS] member row write failed:', err.message);
      continue;
    }

    try {
      await stageComboEvent({
        comboId: combo.id,
        alertId,
        deviceId,
        alarmType,
        alarmTs: ctx.alarmTs || null,
      });
      await markAlertsPending([alertId]);
    } catch (err) {
      console.error('[COMBOS] staging failed:', err.message);
      continue;
    }
    staged = true;

    // Footage is requested per member exactly like today, so evidence exists
    // even if the combo never completes.
    try {
      const { requestIncidentFootage } = require('../db/alert_groups');
      requestIncidentFootage(null, {
        alertId,
        deviceId,
        alarmType,
        alarmTs: ctx.alarmTs,
        fleetExact: ctx.fleetNumber || null,
        deviceName: ctx.deviceName,
        sourceType: ctx.sourceType,
      });
    } catch (_) { /* never block detection on evidence capture */ }

    let missing = [];
    try {
      missing = await listMissingMembers(combo.id, deviceId, combo.memberNames, combo.windowSeconds);
    } catch (err) {
      console.error('[COMBOS] completion check failed:', err.message);
      continue;
    }
    if (missing.length > 0) continue; // still waiting on other members

    try {
      const members = await listPendingForComboDevice(combo.id, deviceId, combo.windowSeconds);
      if (members.length === 0) continue;

      const groupRow = await createMergedComboGroup({
        deviceId,
        deviceName: members.find((m) => m.device_name)?.device_name || ctx.deviceName,
        combo: {
          id: combo.id,
          name: combo.name,
          severity: combo.severity,
          source_type: members[0]?.source_type,
        },
        members,
        lastAlertId: alertId,
        lastAlertTs: ctx.alarmTs,
      });
      if (!groupRow) continue;

      await linkStagedMembers({
        comboId: combo.id,
        deviceId,
        windowSeconds: combo.windowSeconds,
        groupId: groupRow.id,
      });
      groupRows.push({ ...groupRow, combo_name: combo.name });
    } catch (err) {
      console.error('[COMBOS] merged group creation failed:', err.message);
    }
  }

  if (groupRows.length > 0) return { action: 'raised', groupRows, staged };
  if (staged) return { action: 'staged', groupRows: [] };
  return { action: 'pass', groupRows: [] };
}

/** Throttled cleanup of staging rows whose window has lapsed. */
async function sweep() {
  try {
    return await sweepExpiredCombos();
  } catch (err) {
    console.error('[COMBOS] sweep failed:', err.message);
    return { expired: 0, released: 0 };
  }
}

/** Read-only snapshot for the settings UI (which combos are armed, and how). */
async function listEnabledCombos(costCenterId) {
  const index = await loadComboIndex();
  const combos = new Map();
  for (const list of Object.values(index)) {
    for (const combo of list) combos.set(combo.id, combo);
  }
  const ccId = costCenterId == null || costCenterId === '' ? null : Number(costCenterId);
  return Array.from(combos.values())
    .filter((c) => (ccId == null ? true : c.ccOverrides.has(ccId)))
    .map((c) => ({
      id: c.id,
      name: c.name,
      severity: (ccId != null && c.ccOverrides.get(ccId)?.severity) || c.baseSeverity,
      window_seconds: c.windowSeconds,
      member_names: c.memberNames,
    }));
}

module.exports = {
  handleDetection,
  findCombosForMember,
  listEnabledCombos,
  sweep,
  invalidate,
};