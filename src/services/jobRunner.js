// Background job runner — everything the user should never wait for.
//
//   resolve → close the alert group (+ member detections) for a saved NCR
//   email   → hand the escalation email to the outbox for delivery
//   footage → request + store incident footage for collision alerts
//
// Same shape as the email sweeper: a timer, FOR UPDATE SKIP LOCKED claiming,
// exponential backoff and a hard attempt cap.
const db = require('../db');
const { closeAlertGroup } = require('./alertClosureService');

const TICK_MS = 15000;
const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [0, 1, 2, 5, 15, 45];

let timer = null;
let running = false;

async function claimJobs(limit = 5) {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'running', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status IN ('pending', 'failed')
         AND attempts < $1
         AND next_retry_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, job_type, payload, ncr_form_id, incident_id, alert_group_id, attempts`,
    [MAX_ATTEMPTS, limit]
  );
  return rows;
}

async function runJob(job) {
  const payload = job.payload || {};
  if (job.job_type === 'resolve') {
    const res = await closeAlertGroup({
      groupId: job.alert_group_id,
      userId: payload.userId,
      notes: payload.notes,
      closureType: payload.closureType || 'ncr',
      action_taken: payload.incident?.action_taken,
      ncr_classification: payload.incident?.infringement,
      close_reason: payload.incident?.infringement_detail,
      reported_by: payload.userId,
      incident: payload.incident || {},
      incidentId: payload.incidentId || job.incident_id || null,
    });
    if (!res.ok) throw new Error(res.error || 'closure failed');
    return res.result;
  }

  if (job.job_type === 'email') {
    // The escalation email is delivered by the existing outbox sweeper; the
    // job only needs to hand it over.
    const { enqueueEscalationEmail } = require('./ncrEmailService');
    const res = await enqueueEscalationEmail(payload);
    return res;
  }

  if (job.job_type === 'footage') {
    const { captureIncidentFootage } = require('./alertFootageService');
    return captureIncidentFootage(payload);
  }

  throw new Error(`unknown job type: ${job.job_type}`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const jobs = await claimJobs(5);
    for (const job of jobs) {
      try {
        const result = await runJob(job);
        await db.query(
          `UPDATE jobs SET status = 'done', error = NULL, updated_at = NOW() WHERE id = $1`,
          [job.id]
        );
        if (job.ncr_form_id) {
          await db.query(
            `UPDATE ncr_forms SET status = 'RESOLVED', updated_at = NOW()
             WHERE id = $1 AND status = 'SAVED'`,
            [job.ncr_form_id]
          );
        }
        console.log(`[JOBS] ${job.job_type} #${job.id} done`, result ? '' : '');
      } catch (err) {
        const attempts = (job.attempts || 0) + 1;
        const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
        const dead = attempts >= MAX_ATTEMPTS;
        await db.query(
          `UPDATE jobs SET status = $2, attempts = $3, error = $4,
             next_retry_at = NOW() + ($5 || ' minutes')::interval, updated_at = NOW()
           WHERE id = $1`,
          [job.id, dead ? 'dead' : 'failed', attempts, String(err.message || err).slice(0, 500), String(wait)]
        );
        if (dead && job.ncr_form_id) {
          await db.query(
            `UPDATE ncr_forms SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
            [job.ncr_form_id, String(err.message || err).slice(0, 500)]
          );
        }
        console.error(`[JOBS] ${job.job_type} #${job.id} attempt ${attempts} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[JOBS] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  tick().catch(() => {});
  console.log(`[JOBS] runner started (every ${TICK_MS / 1000}s)`);
}

module.exports = { start, tick, runJob, claimJobs };
