const db = require('../db');
const { sendSuccess, sendError } = require('../helpers/response');

// ── Escalation Groups ──

async function listEscalationGroups(req, res) {
  try {
    const { cost_center_id } = req.query;

    let groups;
    if (cost_center_id) {
      groups = await db.query(
        'SELECT * FROM escalation_groups WHERE cost_center_id = $1 ORDER BY name',
        [Number(cost_center_id)]
      );
    } else {
      groups = await db.query('SELECT * FROM escalation_groups ORDER BY name');
    }

    // Fetch members + linked alert groups in two bulk queries
    const groupIds = groups.rows.map((g) => g.id);
    let membersByGroup = {};
    let alertGroupsByGroup = {};
    if (groupIds.length > 0) {
      const members = await db.query(
        `SELECT em.escalation_group_id, em.id, em.email, em.name AS member_name, em.is_active
         FROM escalation_group_members em
         WHERE em.escalation_group_id = ANY($1)
         ORDER BY em.email`,
        [groupIds]
      );
      for (const m of members.rows) {
        if (!membersByGroup[m.escalation_group_id]) membersByGroup[m.escalation_group_id] = [];
        membersByGroup[m.escalation_group_id].push(m);
      }

      const alertGroups = await db.query(
        `SELECT ega.escalation_group_id, agc.id, agc.name
         FROM escalation_group_alert_groups ega
         JOIN alert_group_configs agc ON agc.id = ega.alert_group_config_id
         WHERE ega.escalation_group_id = ANY($1)
         ORDER BY agc.name`,
        [groupIds]
      );
      for (const a of alertGroups.rows) {
        if (!alertGroupsByGroup[a.escalation_group_id]) alertGroupsByGroup[a.escalation_group_id] = [];
        alertGroupsByGroup[a.escalation_group_id].push({ id: a.id, name: a.name });
      }
    }

    const result = groups.rows.map((g) => ({
      ...g,
      members: membersByGroup[g.id] || [],
      alert_groups: alertGroupsByGroup[g.id] || [],
    }));

    sendSuccess(res, result, 'Escalation groups retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function createEscalationGroup(req, res) {
  try {
    const { name, cost_center_id, description = '', emails = [], alert_group_ids = [] } = req.body;
    if (!name) return sendError(res, 'name required', 400);

    const groupResult = await db.query(
      `INSERT INTO escalation_groups (name, cost_center_id, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), cost_center_id != null ? Number(cost_center_id) : null, description]
    );
    const group = groupResult.rows[0];

    await insertMembers(group.id, emails);
    await insertAlertGroups(group.id, alert_group_ids);

    const result = await fetchGroupWithRelations(group.id);
    sendSuccess(res, result, 'Escalation group created');
  } catch (error) {
    if (error.code === '23505') return sendError(res, 'An escalation group with this name already exists for this cost center', 409);
    sendError(res, error.message, 500);
  }
}

async function updateEscalationGroup(req, res) {
  try {
    const { id } = req.params;
    const { name, cost_center_id, description, is_active, emails, alert_group_ids } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (cost_center_id !== undefined) { fields.push(`cost_center_id = $${idx++}`); values.push(cost_center_id != null ? Number(cost_center_id) : null); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
    fields.push(`updated_at = NOW()`);

    if (fields.length > 1) {
      values.push(id);
      await db.query(`UPDATE escalation_groups SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    }

    // Replace members and linked alert groups if provided
    if (Array.isArray(emails)) {
      await db.query('DELETE FROM escalation_group_members WHERE escalation_group_id = $1', [id]);
      await insertMembers(id, emails);
    }
    if (Array.isArray(alert_group_ids)) {
      await db.query('DELETE FROM escalation_group_alert_groups WHERE escalation_group_id = $1', [id]);
      await insertAlertGroups(id, alert_group_ids);
    }

    const result = await fetchGroupWithRelations(id);
    if (!result) return sendError(res, 'Not found', 404);
    sendSuccess(res, result, 'Escalation group updated');
  } catch (error) {
    if (error.code === '23505') return sendError(res, 'An escalation group with this name already exists for this cost center', 409);
    sendError(res, error.message, 500);
  }
}

async function deleteEscalationGroup(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM escalation_groups WHERE id = $1', [id]);
    sendSuccess(res, { id: Number(id) }, 'Escalation group deleted');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

// ── Helpers ──

async function insertMembers(groupId, emails) {
  const list = Array.isArray(emails) ? emails : [];
  if (list.length > 0) {
    const values = list.map((_, i) => `($1, $${i + 2})`).join(', ');
    await db.query(
      `INSERT INTO escalation_group_members (escalation_group_id, email) VALUES ${values}`,
      [groupId, ...list]
    );
  }
}

async function insertAlertGroups(groupId, alertGroupIds) {
  const list = Array.isArray(alertGroupIds) ? alertGroupIds : [];
  if (list.length > 0) {
    const placeholders = list.map((_, i) => `($1, $${i + 2})`).join(', ');
    await db.query(
      `INSERT INTO escalation_group_alert_groups (escalation_group_id, alert_group_config_id) VALUES ${placeholders}
       ON CONFLICT DO NOTHING`,
      [groupId, ...list]
    );
  }
}

async function fetchGroupWithRelations(id) {
  const group = await db.query('SELECT * FROM escalation_groups WHERE id = $1', [id]);
  if (group.rows.length === 0) return null;

  const members = await db.query(
    `SELECT id, email, name AS member_name, is_active FROM escalation_group_members
     WHERE escalation_group_id = $1 ORDER BY email`,
    [id]
  );
  const alertGroups = await db.query(
    `SELECT agc.id, agc.name FROM escalation_group_alert_groups ega
     JOIN alert_group_configs agc ON agc.id = ega.alert_group_config_id
     WHERE ega.escalation_group_id = $1 ORDER BY agc.name`,
    [id]
  );

  return {
    ...group.rows[0],
    members: members.rows,
    alert_groups: alertGroups.rows,
  };
}

// ── Available alert groups for selection ──

async function listAlertGroupsForSelection(req, res) {
  try {
    const result = await db.query('SELECT id, name, severity FROM alert_group_configs ORDER BY name');
    sendSuccess(res, result.rows, 'Alert groups retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

module.exports = {
  listEscalationGroups,
  createEscalationGroup,
  updateEscalationGroup,
  deleteEscalationGroup,
  listAlertGroupsForSelection,
};
