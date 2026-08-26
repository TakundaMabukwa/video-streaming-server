const { query } = require('../db');

let checkInterval = null;
let broadcastFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

async function checkDrivingTimeViolations() {
  try {
    // Get the Driver Hours rule
    const ruleResult = await query(
      "SELECT max_value FROM rtms_rules WHERE rule_name = 'Driver Hours' AND enabled = true LIMIT 1"
    );

    if (ruleResult.rows.length === 0) return;
    const maxMinutes = parseFloat(ruleResult.rows[0].max_value) || 240; // default 4 hours

    // Find active sessions exceeding max time
    const sessions = await query(`
      SELECT s.*, 
        EXTRACT(EPOCH FROM (NOW() - s.engine_on_at)) / 60 as elapsed_minutes
      FROM rtms_driving_sessions s
      WHERE s.engine_off_at IS NULL 
        AND s.alert_sent = false
        AND EXTRACT(EPOCH FROM (NOW() - s.engine_on_at)) / 60 >= $1
      ORDER BY s.engine_on_at ASC
    `, [maxMinutes]);

    for (const session of sessions.rows) {
      // Mark alert as sent
      await query(
        'UPDATE rtms_driving_sessions SET alert_sent = true WHERE id = $1',
        [session.id]
      );

      // Send websocket alert
      if (broadcastFn) {
        const elapsed = Math.round(parseFloat(session.elapsed_minutes));
        broadcastFn({
          type: 'rtms_driving_time_alert',
          device_id: session.device_id,
          fleet_number: session.fleet_number,
          registration_number: session.registration_number,
          message: `Driving time exceeded: ${elapsed} minutes (max: ${maxMinutes} min)`,
          elapsed_minutes: elapsed,
          max_minutes: maxMinutes,
          engine_on_at: session.engine_on_at,
          timestamp: new Date().toISOString(),
        });
        console.log(`[RTMS] Driving time alert sent for ${session.fleet_number || session.device_id}: ${elapsed}min`);
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
