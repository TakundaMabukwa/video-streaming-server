const db = require('../db');
const { sendSuccess, sendError } = require('../helpers/response');

// ── Escalation Groups ──
// A group is a shared contact list. Notifications are sent per category,
// each scoped to its own cost-center array. Empty array = all cost centers.

function toIntArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => Number(v)).filter((n) => Number.isInteger(n)))];
}

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

    // Fetch members in one bulk query
    const groupIds = groups.rows.map((g) => g.id);
    let membersByGroup = {};
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
    }

    const result = groups.rows.map((g) => ({
      ...g,
      repair_cost_center_ids: g.repair_cost_center_ids || [],
      ncr_cost_center_ids: g.ncr_cost_center_ids || [],
      members: membersByGroup[g.id] || [],
    }));

    sendSuccess(res, result, 'Escalation groups retrieved');
  } catch (error) {
    sendError(res, error.message, 500);
  }
}

async function createEscalationGroup(req, res) {
  try {
    const {
      name,
      cost_center_id,
      description = '',
      emails = [],
      repair_cost_center_ids = [],
      ncr_cost_center_ids = [],
    } = req.body;
    if (!name) return sendError(res, 'name required', 400);

    const repairCcs = toIntArray(repair_cost_center_ids);
    const ncrCcs = toIntArray(ncr_cost_center_ids);

    const groupResult = await db.query(
      `INSERT INTO escalation_groups (name, cost_center_id, description, repair_cost_center_ids, ncr_cost_center_ids)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        name.trim(),
        cost_center_id != null ? Number(cost_center_id) : null,
        description,
        repairCcs,
        ncrCcs,
      ]
    );
    const group = groupResult.rows[0];

    await insertMembers(group.id, emails);

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
    const {
      name,
      cost_center_id,
      description,
      is_active,
      emails,
      repair_cost_center_ids,
      ncr_cost_center_ids,
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (cost_center_id !== undefined) { fields.push(`cost_center_id = $${idx++}`); values.push(cost_center_id != null ? Number(cost_center_id) : null); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
    if (repair_cost_center_ids !== undefined) {
      if (!Array.isArray(repair_cost_center_ids)) return sendError(res, 'repair_cost_center_ids must be an array', 400);
      fields.push(`repair_cost_center_ids = $${idx++}`);
      values.push(toIntArray(repair_cost_center_ids));
    }
    if (ncr_cost_center_ids !== undefined) {
      if (!Array.isArray(ncr_cost_center_ids)) return sendError(res, 'ncr_cost_center_ids must be an array', 400);
      fields.push(`ncr_cost_center_ids = $${idx++}`);
      values.push(toIntArray(ncr_cost_center_ids));
    }
    fields.push(`updated_at = NOW()`);

    if (fields.length > 1) {
      values.push(id);
      await db.query(`UPDATE escalation_groups SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    }

    // Replace members if provided
    if (Array.isArray(emails)) {
      await db.query('DELETE FROM escalation_group_members WHERE escalation_group_id = $1', [id]);
      await insertMembers(id, emails);
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

async function fetchGroupWithRelations(id) {
  const group = await db.query('SELECT * FROM escalation_groups WHERE id = $1', [id]);
  if (group.rows.length === 0) return null;

  const members = await db.query(
    `SELECT id, email, name AS member_name, is_active FROM escalation_group_members
     WHERE escalation_group_id = $1 ORDER BY email`,
    [id]
  );

  return {
    ...group.rows[0],
    repair_cost_center_ids: group.rows[0].repair_cost_center_ids || [],
    ncr_cost_center_ids: group.rows[0].ncr_cost_center_ids || [],
    members: members.rows,
  };
}

module.exports = {
  listEscalationGroups,
  createEscalationGroup,
  updateEscalationGroup,
  deleteEscalationGroup,
};
