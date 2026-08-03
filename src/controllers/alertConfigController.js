const db = require('../db');
const { sendSuccess, sendError } = require('../helpers/response');

// ── Alert Definitions CRUD ──

async function listAlertDefinitions(req, res) {
  try {
    const { category } = req.query;
    let sql = 'SELECT * FROM alert_definitions';
    const params = [];
    if (category) {
      sql += ' WHERE category = $1';
      params.push(category);
    }
    sql += ' ORDER BY category, name';
    const result = await db.query(sql, params);
    sendSuccess(res, result.rows, 'Alert definitions retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function createAlertDefinition(req, res) {
  try {
    const { name, category, description = '', signal_code = '' } = req.body;
    if (!name || !category) return sendError(res, 'name and category required', 400);
    if (!['telematics', 'video'].includes(category)) return sendError(res, 'category must be telematics or video', 400);

    const result = await db.query(
      `INSERT INTO alert_definitions (name, category, description, signal_code)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), category, description, signal_code]
    );
    sendSuccess(res, result.rows[0], 'Alert definition created');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function updateAlertDefinition(req, res) {
  try {
    const { id } = req.params;
    const { name, category, description, signal_code, is_active } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (category !== undefined) {
      if (!['telematics', 'video'].includes(category)) return sendError(res, 'category must be telematics or video', 400);
      fields.push(`category = $${idx++}`); values.push(category);
    }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (signal_code !== undefined) { fields.push(`signal_code = $${idx++}`); values.push(signal_code); }
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
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function deleteAlertDefinition(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM alert_definitions WHERE id = $1', [id]);
    sendSuccess(res, { id }, 'Alert definition deleted');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// ── Alert Group Configs CRUD ──

async function listAlertGroupConfigs(req, res) {
  try {
    const groups = await db.query('SELECT * FROM alert_group_configs ORDER BY severity, name');

    // Fetch members for each group
    const members = await db.query(`
      SELECT agcm.group_config_id, ad.*
      FROM alert_group_config_members agcm
      JOIN alert_definitions ad ON ad.id = agcm.alert_definition_id
      ORDER BY ad.category, ad.name
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

async function createAlertGroupConfig(req, res) {
  try {
    const { name, severity, description = '', member_ids = [] } = req.body;
    if (!name) return sendError(res, 'name required', 400);
    if (!Number.isFinite(severity) || severity < 1 || severity > 10) return sendError(res, 'severity must be 1-10', 400);

    const groupResult = await db.query(
      `INSERT INTO alert_group_configs (name, severity, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), severity, description]
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
      if (severity < 1 || severity > 10) return sendError(res, 'severity must be 1-10', 400);
      fields.push(`severity = $${idx++}`); values.push(severity);
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

module.exports = {
  listAlertDefinitions,
  createAlertDefinition,
  updateAlertDefinition,
  deleteAlertDefinition,
  listAlertGroupConfigs,
  createAlertGroupConfig,
  updateAlertGroupConfig,
  deleteAlertGroupConfig,
};
