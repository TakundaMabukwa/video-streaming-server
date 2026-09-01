const { query } = require('../db');

let checkInterval = null;
let broadcastFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

async function getDriverHoursMaxMinutes(costCenterId) {
  const result = await query(
    `SELECT max_value FROM rtms_rules
     WHERE rule_name = 'Driver Hours' AND enabled = true
     AND (cost_center_id = $1 OR cost_center_id IS NULL)
     ORDER BY cost_center_id IS NOT NULL DESC
     LIMIT 1`,
    [costCenterId == null ? 0 : costCenterId]
  );
  if (result.rows.length === 0) return null;
  return parseFloat(result.rows[0].max_value) || 240;
}

async function checkDrivingTimeViolations() {
  try {
    // Get the global default Driver Hours rule (fallback)
    const defaultMax = await getDriverHoursMaxMinutes(null);
    if (defaultMax == null) {
      return; // no rule configured at all
    }

    // Find active sessions that are eligible (no alert sent yet)
    const sessions = await query(`
      SELECT s.*, 
        EXTRACT(EPOCH FROM (NOW() - s.engine_on_at)) / 60 as elapsed_minutes
      FROM rtms_driving_sessions s
      WHERE s.engine_off_at IS NULL 
        AND s.alert_sent = false
        AND EXTRACT(EPOCH FROM (NOW() - s.engine_on_at)) / 60 >= $1
      ORDER BY s.engine_on_at ASC
    `, [0]);

    for (const session of sessions.rows) {
      // Resolve the max minutes for this session's cost center
      const maxMinutes = await getDriverHoursMaxMinutes(session.cost_center_id) || defaultMax;
      const elapsed = parseFloat(session.elapsed_minutes);
      if (elapsed < maxMinutes) continue;

      // Mark alert as sent
      await query(
        'UPDATE rtms_driving_sessions SET alert_sent = true WHERE id = $1',
        [session.id]
      );

      // Send websocket alert
      if (broadcastFn) {
        const elapsedRounded = Math.round(elapsed);
        broadcastFn({
          type: 'rtms_driving_time_alert',
          device_id: session.device_id,
          fleet_number: session.fleet_number,
          registration_number: session.registration_number,
          message: `Driving time exceeded: ${elapsedRounded} minutes (max: ${maxMinutes} min)`,
          elapsed_minutes: elapsedRounded,
          max_minutes: maxMinutes,
          engine_on_at: session.engine_on_at,
          timestamp: new Date().toISOString(),
        });
        console.log(`[RTMS] Driving time alert sent for ${session.fleet_number || session.device_id}: ${elapsedRounded}min`);
      }
    }
  } catch (err) {
    console.error('[RTMS] Check driving time error:', err.message);
  }
}

function startMonitoring(intervalMs = 60000) {
  if (checkInterval) return;
  checkInterval = setInterval(checkDrivingTimeViolations, intervalMs);
  console.log(`[RTMS] Driving time monitoring started (interval: ${intervalMs}ms)`);
}

function stopMonitoring() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('[RTMS] Driving time monitoring stopped');
  }
}

module.exports = {
  setBroadcast,
  startMonitoring,
  stopMonitoring,
  checkDrivingTimeViolations,
};
