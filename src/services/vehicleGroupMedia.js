// Media for every detection in an alert group.
//
// The annexure of an NCR normally shows only the alert that was opened. With
// "apply all media to docs" the annexure shows the media of EVERY detection
// in the group, so a burst of collisions is documented in full.
const db = require('../db');
const syncService = require('./syncService');

const CONCURRENCY = 6;
const PER_ALERT_TIMEOUT_MS = 6000;
// Live camera lookups are slow and the HTTP server cuts a socket off after
// 30s (server.setTimeout). Stop starting new work before that and return what
// we have, flagged as partial, instead of letting the whole request 500.
const OVERALL_BUDGET_MS = 18000;

/** Member detections of a group, newest first. */
async function groupMembers(groupId, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, device_id, device_name, alarm_type, alarm_ts, lat, lon, speed
     FROM alerts
     WHERE alert_group_id = $1
     ORDER BY alarm_ts DESC NULLS LAST, id DESC
     LIMIT $2`,
    [groupId, limit]
  );
  return rows;
}

/**
 * Media for every member detection of a group.
 * @returns {Promise<{media: any[], members: number, partial: boolean}>}
 */
async function mediaForGroup(groupId, { limit = 50 } = {}) {
  const members = await groupMembers(groupId, limit);
  if (members.length === 0) return { media: [], members: 0, partial: false };

  const collected = [];
  const startedAt = Date.now();
  let partial = false;
  let cursor = 0;
  let processed = 0;

  const worker = async () => {
    while (cursor < members.length) {
      if (Date.now() - startedAt >= OVERALL_BUDGET_MS) return;
      const member = members[cursor++];
      processed += 1;
      let timer = null;
      try {
        const media = await Promise.race([
          syncService.fetchMediaOnDemand(member),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('media timeout')), PER_ALERT_TIMEOUT_MS);
          }),
        ]);
        for (const m of media || []) {
          collected.push({
            ...m,
            alert_id: member.id,
            alarm_type: member.alarm_type,
            alarm_ts: member.alarm_ts,
          });
        }
      } catch (err) {
        partial = true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, members.length) }, () => worker())
  );

  // Anything not attempted before the deadline makes this a partial result.
  if (processed < members.length) partial = true;

  return { media: collected, members: members.length, partial };
}

module.exports = { mediaForGroup, groupMembers };
