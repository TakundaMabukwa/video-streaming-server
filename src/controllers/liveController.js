// Live board endpoints: snapshot + SSE stream + presence heartbeat.
const db = require('../db');
const { sendSuccess, sendError } = require('../helpers/response');
const { rowPayload } = require('../live/alertEvents');
const { canSeeFleet } = require('../live/visibility');
const livePresence = require('../live/presence');
const sseHub = require('../live/sseHub');

async function getAlertSnapshot(req, res) {
  try {
    const ccIds = req.userCostCenterIds || [];
    // Read the watermark BEFORE the row query: anything inserted after this
    // point gets revision > asOfRevision and is replayed by the SSE stream.
    const revisionResult = await db.query(
      'SELECT COALESCE(MAX(revision), 0) AS as_of_revision FROM alert_groups'
    );
    const rowsResult = await db.query(
      `SELECT *
         FROM alert_groups
        WHERE resolved = FALSE AND false_alert = FALSE
        ORDER BY last_alert_ts DESC NULLS LAST`
    );

    const alerts = [];
    for (const row of rowsResult.rows) {
      if (await canSeeFleet(ccIds, row.fleet_number || row.device_id)) {
        alerts.push(rowPayload(row));
      }
    }

    return sendSuccess(res, {
      alerts,
      count: alerts.length,
      asOfRevision: Number(revisionResult.rows[0]?.as_of_revision || 0),
    }, 'Alert snapshot retrieved');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
}

async function streamAlerts(req, res) {
  try {
    const sinceRevision = req.query?.sinceRevision ?? req.query?.since;
    await sseHub.addClient({
      res,
      identity: { id: req.user?.id || null, email: req.user?.email || null },
      ccIds: req.userCostCenterIds || [],
      sinceRevision,
    });
    const cleanup = () => {
      try { res.end(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  } catch (error) {
    try {
      if (!res.headersSent) return sendError(res, error.message, 500);
      res.end();
    } catch { /* ignore */ }
  }
}

async function presenceHeartbeat(req, res) {
  try {
    const body = req.body || {};
    const user = String(req.user?.email || req.user?.id || body.user || '').trim();
    if (!user) return sendError(res, 'Authenticated user required', 401);

    const event = livePresence.heartbeat({
      fleetNumber: body.fleet_number || body.fleetNumber,
      alertGroupId: body.alert_group_id || body.alertGroupId || body.alert_id || body.alertId,
      user,
      action: body.event_action || body.action || 'ENTER',
    });
    if (!event) return sendError(res, 'fleet_number and user are required', 400);
    sseHub.publishPresence(event);
    return sendSuccess(res, { event }, 'Presence recorded');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
}

function getPresenceSnapshot(req, res) {
  return sendSuccess(res, livePresence.snapshot(), 'Presence snapshot retrieved');
}

function getLiveHealth(req, res) {
  return sendSuccess(res, sseHub.getHealth(), 'Live stream health');
}

module.exports = {
  getAlertSnapshot,
  streamAlerts,
  presenceHeartbeat,
  getPresenceSnapshot,
  getLiveHealth,
};
