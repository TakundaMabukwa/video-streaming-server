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
      // Return base definitions with CC override merged via LEFT JOIN
      const ccId = Number(cost_center_id);
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
         ${whereClause}
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
  } catch (error) {
    if (error.code === '23505') return sendError(res, 'An alert definition with this signal code already exists', 409);
    sendError(res, error.message, 500);
  }
}

async function deleteAlertDefinition(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM alert_definitions WHERE id = $1', [id]);
    sendSuccess(res, { id }, 'Alert definition deleted');
    invalidateCache();
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
    let idx = 3;

    if (severity !== undefined) { fields.push(`severity`); values.push(String(severity).toUpperCase()); }
    if (description !== undefined) { fields.push(`description`); values.push(description); }
    if (is_active !== undefined) { fields.push(`is_active`); values.push(is_active); }

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
      let idx = 3;

      if (severity !== undefined) { fields.push(`severity`); values.push(String(severity).toUpperCase()); }
      if (description !== undefined) { fields.push(`description`); values.push(description); }
      if (is_active !== undefined) { fields.push(`is_active`); values.push(is_active); }

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
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function deleteDefinitionOverride(req, res) {
  try {
    const { definition_id, cc_id } = req.params;
    await db.query(
      'DELETE FROM alert_definition_overrides WHERE alert_definition_id = $1 AND cost_center_id = $2',
      [Number(definition_id), Number(cc_id)]
    );
    sendSuccess(res, { definition_id: Number(definition_id), cost_center_id: Number(cc_id) }, 'Override deleted');
    invalidateCache();
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

async function createAlertGroupConfig(req, res) {
  try {
    const { name, severity, description = '', member_ids = [] } = req.body;
    if (!name) return sendError(res, 'name required', 400);
    const sev = (severity || 'MEDIUM').toUpperCase();
    if (!VALID_SEVERITY.includes(sev)) return sendError(res, 'severity must be CRITICAL, HIGH, MEDIUM, or LOW', 400);

    const groupResult = await db.query(
      `INSERT INTO alert_group_configs (name, severity, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), sev, description]
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

    sendSuccess(res, { ...group, members: members.rows }, 'Alert group config created');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function updateAlertGroupConfig(req, res) {
  try {
    const { id } = req.params;
    const { name, severity, description, is_active, member_ids } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (severity !== undefined) {
      const sev = String(severity).toUpperCase();
      if (!VALID_SEVERITY.includes(sev)) return sendError(res, 'severity must be CRITICAL, HIGH, MEDIUM, or LOW', 400);
      fields.push(`severity = $${idx++}`); values.push(sev);
    }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
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
    sendSuccess(res, { ...group.rows[0], members: members.rows }, 'Alert group config updated');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function deleteAlertGroupConfig(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM alert_group_configs WHERE id = $1', [id]);
    sendSuccess(res, { id }, 'Alert group config deleted');
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
  listAlertGroupConfigs,
  createAlertGroupConfig,
  updateAlertGroupConfig,
  deleteAlertGroupConfig,
  upsertGroupConfigOverride,
  bulkUpsertGroupConfigOverrides,
  deleteGroupConfigOverride,
};
