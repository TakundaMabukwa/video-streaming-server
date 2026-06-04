const { query } = require('./pool');

const MAX_DOCUMENTS = 100;

async function updateAlertStatus(alertId, updates) {
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
  if (updates.notes !== undefined) {
    sets.push(`notes = $${idx++}`);
    params.push(updates.notes);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  sets.push(`updated_at = NOW()`);

  params.push(alertId);
  const result = await query(
    `UPDATE alerts SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function addAlertDocument(alertId, document) {
  const result = await query(
    `UPDATE alerts SET documents = CASE WHEN jsonb_array_length(documents) < ${MAX_DOCUMENTS} THEN documents || $1::jsonb ELSE documents END, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(document), alertId]
  );
  return result.rows[0] || null;
}

module.exports = { updateAlertStatus, addAlertDocument };
