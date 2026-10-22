// Media for every detection in an alert group.
//
// The annexure of an NCR normally shows only the alert that was opened. With
// "apply all media to docs" the annexure shows the media of EVERY detection
// in the group, so a burst of collisions is documented in full.
const db = require('../db');
const syncService = require('./syncService');

const CONCURRENCY = 6;
const PER_ALERT_TIMEOUT_MS = 8000;

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
  let partial = false;
  let cursor = 0;

  const worker = async () => {
    while (cursor < members.length) {
      const member = members[cursor++];
      try {
        const media = await Promise.race([
          syncService.fetchMediaOnDemand(member),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('media timeout')), PER_ALERT_TIMEOUT_MS)
          ),
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
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, members.length) }, () => worker())
  );

  return { media: collected, members: members.length, partial };
}

module.exports = { mediaForGroup, groupMembers };
