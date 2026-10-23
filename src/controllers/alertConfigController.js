const db = require('../db');
const { sendSuccess, sendError } = require('../helpers/response');
const { invalidateCache } = require('../db/alert_definitions');

// ── Alert Definitions (base/global only) ──

async function listAlertDefinitions(req, res) {
  try {
    const { category, cost_center_id } = req.query;
    const params = [];
    const conds = [];

    if (category) {
      conds.push(`d.category = $${params.length + 1}`);
      params.push(category);
    }

    const whereClause = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    if (cost_center_id) {
      // Return base definitions with CC override merged via LEFT JOIN.
      // in_set=true  (default) -> only defs actually IN this CC's set, so a
      //                 deleted (soft-removed) def disappears from the list.
      // in_set=false         -> only defs NOT in the set ("Override from Global").
      const ccId = Number(cost_center_id);
      const inSet = String(req.query.in_set ?? 'true') !== 'false';
      const setFilter = inSet ? 'o.id IS NOT NULL' : 'o.id IS NULL';
      const finalWhere = whereClause
        ? `${whereClause} AND ${setFilter}`
        : `WHERE ${setFilter}`;
      const result = await db.query(
        `SELECT d.*,
                o.severity   AS override_severity,
                o.description AS override_description,
                o.is_active  AS override_is_active,
                o.id         AS override_id,
                o.cost_center_id AS override_cc_id
         FROM alert_definitions d
         LEFT JOIN alert_definition_overrides o
           ON o.alert_definition_id = d.id AND o.cost_center_id = $${params.length + 1}
           AND o.is_active IS DISTINCT FROM false
         ${finalWhere}
         ORDER BY d.name`,
        [...params, ccId]
      );
      sendSuccess(res, result.rows, 'Alert definitions retrieved');
    } else {
      // Global view — just base definitions
      const result = await db.query(
        `SELECT d.* FROM alert_definitions d ${whereClause} ORDER BY d.name`,
        params
      );
      sendSuccess(res, result.rows, 'Alert definitions retrieved');
    }
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function createAlertDefinition(req, res) {
  try {
    const { name, category, description = '', signal_code = '', severity = 'MEDIUM' } = req.body;
    if (!name || !category) return sendError(res, 'name and category required', 400);
    if (!['telematics', 'video'].includes(category)) return sendError(res, 'category must be telematics or video', 400);

    const result = await db.query(
      `INSERT INTO alert_definitions (name, category, description, signal_code, severity)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), category, description, signal_code.trim() || null, String(severity).toUpperCase()]
    );
    sendSuccess(res, result.rows[0], 'Alert definition created');
    if (category === 'video') invalidateCache();
  } catch (error) {
    if (error.code === '23505') return sendError(res, 'An alert definition with this signal code already exists', 409);
    sendError(res, error.message, 500);
  }
}

async function updateAlertDefinition(req, res) {
  try {
    const { id } = req.params;
    const { name, category, description, signal_code, is_active, severity } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (category !== undefined) {
      if (!['telematics', 'video'].includes(category)) return sendError(res, 'category must be telematics or video', 400);
      fields.push(`category = $${idx++}`); values.push(category);
    }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (signal_code !== undefined) { fields.push(`signal_code = $${idx++}`); values.push(signal_code.trim() || null); }
    if (severity !== undefined) { fields.push(`severity = $${idx++}`); values.push(String(severity).toUpperCase()); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
    fields.push(`updated_at = NOW()`);

    if (fields.length === 1) return sendError(res, 'No fields to update', 400);
    values.push(id);
    const result = await db.query(
      `UPDATE alert_definitions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return sendError(res, 'Not found', 404);
    sendSuccess(res, result.rows[0], 'Alert definition updated');
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    if (error.code === '23505') return sendError(res, 'An alert definition with this signal code already exists', 409);
    sendError(res, error.message, 500);
  }
}

async function deleteAlertDefinition(req, res) {
  try {
    const { id } = req.params;
    const purged = await purgeDefinitionAlertRows(id);
    await db.query('DELETE FROM alert_definitions WHERE id = $1', [id]);
    sendSuccess(res, { id, purged }, 'Alert definition deleted');
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// ── Alert Definition Overrides (CC-specific) ──

async function upsertDefinitionOverride(req, res) {
  try {
    const { definition_id } = req.params;
    const { cost_center_id, severity, description, is_active } = req.body;
    if (cost_center_id === undefined) return sendError(res, 'cost_center_id required', 400);

    const fields = ['alert_definition_id', 'cost_center_id'];
    const values = [Number(definition_id), Number(cost_center_id)];

    if (severity !== undefined) { fields.push(`severity`); values.push(String(severity).toUpperCase()); }
    if (description !== undefined) { fields.push(`description`); values.push(description); }
    // Always carry is_active (default TRUE): saving an override re-adds it,
    // which also reactivates a previously soft-removed (is_active=FALSE) row.
    fields.push(`is_active`);
    values.push(is_active === undefined ? true : is_active);

    const result = await db.query(
      `INSERT INTO alert_definition_overrides (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (alert_definition_id, cost_center_id)
       DO UPDATE SET ${fields.slice(2).map(f => `${f} = EXCLUDED.${f}`).join(', ')},
                     updated_at = NOW()
       RETURNING *`,
      values
    );
    sendSuccess(res, result.rows[0], 'Override saved');
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function bulkUpsertDefinitionOverrides(req, res) {
  try {
    const { definition_id } = req.params;
    const { cost_center_ids = [], severity, description, is_active } = req.body;
    if (!cost_center_ids.length) return sendError(res, 'cost_center_ids required', 400);

    const results = [];
    for (const ccId of cost_center_ids) {
      const fields = ['alert_definition_id', 'cost_center_id'];
      const values = [Number(definition_id), Number(ccId)];

      if (severity !== undefined) { fields.push(`severity`); values.push(String(severity).toUpperCase()); }
      if (description !== undefined) { fields.push(`description`); values.push(description); }
      // Always carry is_active (default TRUE): saving re-adds / reactivates
      // a soft-removed (is_active=FALSE) row.
      fields.push(`is_active`);
      values.push(is_active === undefined ? true : is_active);

      const result = await db.query(
        `INSERT INTO alert_definition_overrides (${fields.join(', ')})
         VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (alert_definition_id, cost_center_id)
         DO UPDATE SET ${fields.slice(2).map(f => `${f} = EXCLUDED.${f}`).join(', ')},
                       updated_at = NOW()
         RETURNING *`,
        values
      );
      results.push(result.rows[0]);
    }
    sendSuccess(res, results, `${results.length} override(s) saved`);
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function deleteDefinitionOverride(req, res) {
  try {
    const { definition_id, cc_id } = req.params;
    // Soft-remove: keep the row with is_active = FALSE so the boot-time
    // STRICT CC backfill (ON CONFLICT DO NOTHING) does not resurrect it.
    await db.query(
      'UPDATE alert_definition_overrides SET is_active = FALSE, updated_at = NOW() WHERE alert_definition_id = $1 AND cost_center_id = $2',
      [Number(definition_id), Number(cc_id)]
    );
    sendSuccess(res, { definition_id: Number(definition_id), cost_center_id: Number(cc_id) }, 'Override deleted');
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// Delete stored alert rows for a definition (exact name + signal_code matches
// in alerts / alert_groups). Deletes BOTH resolved and unresolved rows — deleting
// the alert type means the alert is no longer needed at all.
// Executes atomically (all-or-nothing) to avoid partial purges.
async function purgeDefinitionAlertRows(definitionId) {
  const def = await db.query(
    'SELECT name, signal_code FROM alert_definitions WHERE id = $1',
    [Number(definitionId)]
  );
  if (def.rows.length === 0) return { alerts: 0, groups: 0 };
  const types = [def.rows[0].name, def.rows[0].signal_code].filter(Boolean);
  if (types.length === 0) return { alerts: 0, groups: 0 };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // alerts rows are deleted first so alert_groups.last_alert_id never dangles.
    const a = await client.query('DELETE FROM alerts WHERE alarm_type = ANY($1::text[])', [types]);
    const g = await client.query('DELETE FROM alert_groups WHERE alarm_type = ANY($1::text[])', [types]);
    await client.query('COMMIT');
    return { alerts: a.rowCount, groups: g.rowCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// List the cost centers that currently have an override for a definition —
// i.e. the cost centers this alert type is applicable to (in-set for).
async function listDefinitionApplicableCcs(req, res) {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT DISTINCT cost_center_id FROM alert_definition_overrides WHERE alert_definition_id = $1 AND is_active IS DISTINCT FROM false',
      [Number(id)]
    );
    sendSuccess(res, { definition_id: Number(id), cost_center_ids: result.rows.map(r => r.cost_center_id) }, 'Applicable cost centers retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// All applicable CCs for every definition at once — { [definitionId]: [ccIds] }.
// Used by the settings display to show which cost centers each alert type applies to.
async function listAllDefinitionApplicableCcs(req, res) {
  try {
    const result = await db.query(
      'SELECT alert_definition_id, cost_center_id FROM alert_definition_overrides WHERE is_active IS DISTINCT FROM false'
    );
    const map = {};
    for (const r of result.rows) {
      if (!map[r.alert_definition_id]) map[r.alert_definition_id] = [];
      map[r.alert_definition_id].push(r.cost_center_id);
    }
    sendSuccess(res, { cost_center_map: map }, 'Applicable cost centers retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// Delete ALL cost-center overrides for a definition — removes the alert from
// every cost center's set at once (strict CC model: no global fallback for CC
// vehicles, so the alert stops coming in everywhere except CC-less vehicles
// served by the global definition, which is left intact).
async function deleteAllDefinitionOverrides(req, res) {
  try {
    const { definition_id } = req.params;
    const purged = await purgeDefinitionAlertRows(definition_id);
    const result = await db.query(
      'UPDATE alert_definition_overrides SET is_active = FALSE, updated_at = NOW() WHERE alert_definition_id = $1',
      [Number(definition_id)]
    );
    sendSuccess(
      res,
      { definition_id: Number(definition_id), removed: result.rowCount, purged },
      `Removed from ${result.rowCount} cost center set(s), purged ${purged.alerts} alert(s) / ${purged.groups} group(s)`
    );
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// ── Alert Group Configs (base/global only) ──

async function listAlertGroupConfigs(req, res) {
  try {
    const { cost_center_id } = req.query;

    let groups;
    if (cost_center_id) {
      const ccId = Number(cost_center_id);
      // in_set=true (default) -> only groups actually IN this CC's set, so a
      // deleted override makes the group disappear instead of popping back.
      // in_set=false -> only groups NOT in the set ("Override from Global").
      const inSet = String(req.query.in_set ?? 'true') !== 'false';
      groups = await db.query(
        `SELECT g.*,
                o.severity   AS override_severity,
                o.description AS override_description,
                o.is_active  AS override_is_active,
                o.id         AS override_id,
                o.cost_center_id AS override_cc_id
         FROM alert_group_configs g
         LEFT JOIN alert_group_config_overrides o
           ON o.group_config_id = g.id AND o.cost_center_id = $1
           AND o.is_active IS DISTINCT FROM false
         WHERE ${inSet ? 'o.id IS NOT NULL' : 'o.id IS NULL'}
         ORDER BY g.name`,
        [ccId]
      );
    } else {
      groups = await db.query('SELECT * FROM alert_group_configs ORDER BY name');
    }

    // Fetch members for each group
    const members = await db.query(`
      SELECT agcm.group_config_id, ad.*
      FROM alert_group_config_members agcm
      JOIN alert_definitions ad ON ad.id = agcm.alert_definition_id
      ORDER BY ad.name
    `);

    const membersByGroup = {};
    for (const m of members.rows) {
      if (!membersByGroup[m.group_config_id]) membersByGroup[m.group_config_id] = [];
      membersByGroup[m.group_config_id].push(m);
    }

    const result = groups.rows.map((g) => ({
      ...g,
      members: membersByGroup[g.id] || [],
    }));

    sendSuccess(res, result, 'Alert group configs retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

const VALID_SEVERITY = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const MIN_COMBO_WINDOW_SECONDS = 30;
const MAX_COMBO_WINDOW_SECONDS = 86400;

// A combo only makes sense with at least two members, otherwise it would hold
// back an alert forever waiting for itself. groupId is null on CREATE, where the
// member rows do not exist yet, so validate the ids against alert_definitions.
async function validateComboMembers(groupId, memberIds, comboEnabled) {
  if (!comboEnabled) return null;
  const ids = Array.isArray(memberIds) ? memberIds.map(Number).filter(Number.isInteger) : [];
  if (ids.length < 2) {
    return 'A combo needs at least 2 alert types. Add another member, or turn the combo off.';
  }
  const active = groupId
    ? await db.query(
      `SELECT d.id, d.name
       FROM alert_group_config_members m
       JOIN alert_definitions d ON d.id = m.alert_definition_id
       WHERE m.group_config_id = $1 AND d.id = ANY($2::int[]) AND d.is_active IS DISTINCT FROM false`,
      [groupId, ids]
    )
    : await db.query(
      `SELECT d.id, d.name FROM alert_definitions d
       WHERE d.id = ANY($1::int[]) AND d.is_active IS DISTINCT FROM false`,
      [ids]
    );
  if (active.rows.length < 2) {
    return 'A combo needs at least 2 ACTIVE alert types.';
  }
  return null;
}

function normalizeComboWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 300;
  return Math.min(MAX_COMBO_WINDOW_SECONDS, Math.max(MIN_COMBO_WINDOW_SECONDS, Math.round(n)));
}

async function createAlertGroupConfig(req, res) {
  try {
    const {
      name,
      severity,
      description = '',
      member_ids = [],
      combo_enabled,
      combo_window_seconds,
    } = req.body;
    if (!name) return sendError(res, 'name required', 400);
    const sev = (severity || 'MEDIUM').toUpperCase();
    if (!VALID_SEVERITY.includes(sev)) return sendError(res, 'severity must be CRITICAL, HIGH, MEDIUM, or LOW', 400);

    // DEFAULT TRUE: a group holding two or more alert types is a combination
    // unless the operator deliberately switches it off. A group that cannot
    // ever complete (fewer than 2 members) is forced off rather than rejected,
    // so an existing "group with one alert" flow keeps working.
    const memberCount = Array.isArray(member_ids) ? member_ids.length : 0;
    const comboRequested = combo_enabled === undefined || combo_enabled === null
      ? true
      : (combo_enabled === true || combo_enabled === 'true');
    const comboOn = comboRequested && memberCount >= 2;
    const comboWindow = normalizeComboWindow(combo_window_seconds);

    const groupResult = await db.query(
      `INSERT INTO alert_group_configs (name, severity, description, combo_enabled, combo_window_seconds)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), sev, description, comboOn, comboWindow]
    );
    const group = groupResult.rows[0];

    if (member_ids.length > 0) {
      const values = member_ids.map((defId, i) => `(${group.id}, $${i + 1})`).join(', ');
      await db.query(
        `INSERT INTO alert_group_config_members (group_config_id, alert_definition_id) VALUES ${values}`,
        member_ids
      );
    }

    const members = await db.query(
      `SELECT ad.* FROM alert_group_config_members agcm
       JOIN alert_definitions ad ON ad.id = agcm.alert_definition_id
       WHERE agcm.group_config_id = $1`,
      [group.id]
    );

    require('../services/alertCombos').invalidate();
    sendSuccess(res, { ...group, members: members.rows }, 'Alert group config created');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function updateAlertGroupConfig(req, res) {
  try {
    const { id } = req.params;
    const {
      name,
      severity,
      description,
      is_active,
      member_ids,
      combo_enabled,
      combo_window_seconds,
    } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    // A combo must keep enough members to ever complete, so validate the member set
    // that will exist AFTER the update — before anything is written. This runs
    // whenever members change or the combo is being switched on, and also when
    // the group is already a combo and only its members are edited.
    const touchesCombo = combo_enabled !== undefined || Array.isArray(member_ids);
    if (touchesCombo) {
      const current = await db.query(
        'SELECT combo_enabled FROM alert_group_configs WHERE id = $1',
        [id]
      );
      const currentlyOn = current.rows[0]?.combo_enabled === true;
      const turningOn = combo_enabled === true || combo_enabled === 'true';
      if (currentlyOn || turningOn) {
        const nextMembers = Array.isArray(member_ids)
          ? member_ids
          : (await db.query(
            `SELECT alert_definition_id AS id FROM alert_group_config_members WHERE group_config_id = $1`,
            [id]
          )).rows.map((r) => r.id);
        const comboError = await validateComboMembers(id, nextMembers, true);
        if (comboError) return sendError(res, comboError, 400);
      }
    }

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (severity !== undefined) {
      const sev = String(severity).toUpperCase();
      if (!VALID_SEVERITY.includes(sev)) return sendError(res, 'severity must be CRITICAL, HIGH, MEDIUM, or LOW', 400);
      fields.push(`severity = $${idx++}`); values.push(sev);
    }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
    if (combo_enabled !== undefined) { fields.push(`combo_enabled = $${idx++}`); values.push(comboOn === true); }
    if (combo_window_seconds !== undefined) {
      fields.push(`combo_window_seconds = $${idx++}`);
      values.push(normalizeComboWindow(combo_window_seconds));
    }
    fields.push(`updated_at = NOW()`);

    if (fields.length > 1) {
      values.push(id);
      await db.query(
        `UPDATE alert_group_configs SET ${fields.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    // Replace members if provided
    if (Array.isArray(member_ids)) {
      await db.query('DELETE FROM alert_group_config_members WHERE group_config_id = $1', [id]);
      if (member_ids.length > 0) {
        const placeholders = member_ids.map((_, i) => `($1, $${i + 2})`).join(', ');
        await db.query(
          `INSERT INTO alert_group_config_members (group_config_id, alert_definition_id) VALUES ${placeholders}`,
          [id, ...member_ids]
        );
      }
    }

    const group = await db.query('SELECT * FROM alert_group_configs WHERE id = $1', [id]);
    const members = await db.query(
      `SELECT ad.* FROM alert_group_config_members agcm
       JOIN alert_definitions ad ON ad.id = agcm.alert_definition_id
       WHERE agcm.group_config_id = $1`,
      [id]
    );

    if (group.rows.length === 0) return sendError(res, 'Not found', 404);
    require('../services/alertCombos').invalidate();
    sendSuccess(res, { ...group.rows[0], members: members.rows }, 'Alert group config updated');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function deleteAlertGroupConfig(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM alert_group_configs WHERE id = $1', [id]);
    require('../services/alertCombos').invalidate();
    sendSuccess(res, { id }, 'Alert group config deleted');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// Combo health for the settings UI. Reports, per combo, any member that is not
// in a cost centre's alert set — such a member never produces a detection, so
// the combo can never complete there. Purely informational: combos are allowed
// to be enabled anyway.
async function listGroupComboWarnings(req, res) {
  try {
    const { cost_center_id } = req.query;
    const ccId = cost_center_id === undefined || cost_center_id === '' ? null : Number(cost_center_id);
    const { listMembersMissingFromCostCenter } = require('../db/combo_groups');
    const { listEnabledCombos } = require('../services/alertCombos');

    const combos = await listEnabledCombos(ccId);
    const warnings = [];
    for (const combo of combos) {
      const missing = ccId == null ? [] : await listMembersMissingFromCostCenter(combo.id, ccId);
      warnings.push({
        id: combo.id,
        name: combo.name,
        severity: combo.severity,
        window_seconds: combo.window_seconds,
        member_names: combo.member_names,
        missing_member_names: missing.map((m) => m.name),
      });
    }
    sendSuccess(res, warnings, 'Combo warnings retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// ── Alert Group Config Overrides (CC-specific) ──

async function upsertGroupConfigOverride(req, res) {
  try {
    const { group_id } = req.params;
    const { cost_center_id, severity, description, is_active } = req.body;
    if (cost_center_id === undefined) return sendError(res, 'cost_center_id required', 400);

    const fields = ['group_config_id', 'cost_center_id'];
    const values = [Number(group_id), Number(cost_center_id)];
    let idx = 3;

    if (severity !== undefined) { fields.push(`severity`); values.push(String(severity).toUpperCase()); }
    if (description !== undefined) { fields.push(`description`); values.push(description); }
    if (is_active !== undefined) { fields.push(`is_active`); values.push(is_active); }

    const result = await db.query(
      `INSERT INTO alert_group_config_overrides (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (group_config_id, cost_center_id)
       DO UPDATE SET ${fields.slice(2).map(f => `${f} = EXCLUDED.${f}`).join(', ')},
                     updated_at = NOW()
       RETURNING *`,
      values
    );
    sendSuccess(res, result.rows[0], 'Override saved');
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function bulkUpsertGroupConfigOverrides(req, res) {
  try {
    const { group_id } = req.params;
    const { cost_center_ids = [], severity, description, is_active } = req.body;
    if (!cost_center_ids.length) return sendError(res, 'cost_center_ids required', 400);

    const results = [];
    for (const ccId of cost_center_ids) {
      const fields = ['group_config_id', 'cost_center_id'];
      const values = [Number(group_id), Number(ccId)];
      let idx = 3;

      if (severity !== undefined) { fields.push(`severity`); values.push(String(severity).toUpperCase()); }
      if (description !== undefined) { fields.push(`description`); values.push(description); }
      if (is_active !== undefined) { fields.push(`is_active`); values.push(is_active); }

      const result = await db.query(
        `INSERT INTO alert_group_config_overrides (${fields.join(', ')})
         VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (group_config_id, cost_center_id)
         DO UPDATE SET ${fields.slice(2).map(f => `${f} = EXCLUDED.${f}`).join(', ')},
                       updated_at = NOW()
         RETURNING *`,
        values
      );
      results.push(result.rows[0]);
    }
    sendSuccess(res, results, `${results.length} override(s) saved`);
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// List the cost centers that currently have an override for a group config —
// i.e. the cost centers this group is applicable to/customized for.
async function listGroupApplicableCcs(req, res) {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT DISTINCT cost_center_id FROM alert_group_config_overrides WHERE group_config_id = $1',
      [Number(id)]
    );
    sendSuccess(res, { group_id: Number(id), cost_center_ids: result.rows.map(r => r.cost_center_id) }, 'Applicable cost centers retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// All applicable CCs for every group at once — { [groupId]: [ccIds] }.
async function listAllGroupApplicableCcs(req, res) {
  try {
    const result = await db.query('SELECT group_config_id, cost_center_id FROM alert_group_config_overrides');
    const map = {};
    for (const r of result.rows) {
      if (!map[r.group_config_id]) map[r.group_config_id] = [];
      map[r.group_config_id].push(r.cost_center_id);
    }
    sendSuccess(res, { cost_center_map: map }, 'Applicable cost centers retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function deleteGroupConfigOverride(req, res) {
  try {
    const { group_id, cc_id } = req.params;
    await db.query(
      'DELETE FROM alert_group_config_overrides WHERE group_config_id = $1 AND cost_center_id = $2',
      [Number(group_id), Number(cc_id)]
    );
    sendSuccess(res, { group_config_id: Number(group_id), cost_center_id: Number(cc_id) }, 'Override deleted');
    invalidateCache();
    require('../services/alertCombos').invalidate();
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

module.exports = {
  listAlertDefinitions,
  createAlertDefinition,
  updateAlertDefinition,
  deleteAlertDefinition,
  upsertDefinitionOverride,
  bulkUpsertDefinitionOverrides,
  deleteDefinitionOverride,
  deleteAllDefinitionOverrides,
  listDefinitionApplicableCcs,
  listAllDefinitionApplicableCcs,
  listAlertGroupConfigs,
  createAlertGroupConfig,
  updateAlertGroupConfig,
  deleteAlertGroupConfig,
  listGroupComboWarnings,
  upsertGroupConfigOverride,
  bulkUpsertGroupConfigOverrides,
  deleteGroupConfigOverride,
  listGroupApplicableCcs,
  listAllGroupApplicableCcs,
};
