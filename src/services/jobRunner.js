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
// The claim limit is the highest per-type cap (the footage job runs longer).
const MAX_ATTEMPTS_CLAIM = 8;
// No job may block the queue for longer than this.
const JOB_TIMEOUT_MS = 120000;
// The archive build only starts work; it returns immediately so it never
// blocks resolve/footage, and the job keeps checking until the ZIP is ready.
const ARCHIVE_MAX_ATTEMPTS = 60;

let timer = null;
let running = false;

async function claimJobs(limit = 5) {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'running', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status IN ('pending', 'failed')
         AND attempts < CASE job_type WHEN 'archive' THEN $3::int ELSE $1::int END
         AND next_retry_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $2::int
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, job_type, payload, ncr_form_id, incident_id, alert_group_id, attempts`,
    [MAX_ATTEMPTS_CLAIM, limit, ARCHIVE_MAX_ATTEMPTS]
  );
  return rows;
}

// The footage job keeps going for hours: a camera that was powered off at the
// crash uploads the file as soon as it is back online.
const BACKOFF_MIN = [0, 1, 2, 5, 15, 45];
const FOOTAGE_BACKOFF_MIN = [0, 1, 3, 10, 30, 60, 120, 180];
const FOOTAGE_MAX_ATTEMPTS = FOOTAGE_BACKOFF_MIN.length;

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
    // Follow up on the footage: poll the upload task and ask the camera
    // again when it never uploaded (it may have been powered off).
    const { refreshIncidentFootage } = require('./alertFootageService');
    return refreshIncidentFootage(payload);
  }

  if (job.job_type === 'archive') {
    // The build itself runs in the background (it downloads hundreds of MB);
    // the job only checks whether it is done and links it to the NCR.
    const archive = require('./incidentArchiveService');
    const groupId = Number(payload.groupId || job.alert_group_id);
    if (!Number.isInteger(groupId) || groupId < 1) throw new Error('archive job has no group id');
    const row = await archive.getGroupArchive(groupId);
    if (row?.status === 'READY' && row.url) {
      await archive.markForms(groupId, 'READY', { url: row.url });
      return { ready: true, url: row.url };
    }
    archive.buildGroupArchive(groupId, { requestedBy: payload.userId || null }).catch((err) => {
      console.error('[JOBS] archive build failed:', err.message);
    });
    return { ready: false };
  }

  throw new Error(`unknown job type: ${job.job_type}`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const jobs = await claimJobs(5);
    // The jobs run one after the other, but every one of them is capped so a
    // slow camera can never stall the queue.
    for (const job of jobs) {
      try {
        const result = await withTimeout(runJob(job), JOB_TIMEOUT_MS, `${job.job_type} #${job.id} timed out`);

        // The footage job is only finished when the uploaded file is there.
        // While the camera has not uploaded it yet, keep the job alive.
        if (job.job_type === 'footage' && !footageComplete(result)) {
          await scheduleRetry(job, 'Waiting for the camera to upload the footage');
          continue;
        }

        // The archive job stays alive until the ZIP is built and linked.
        if (job.job_type === 'archive' && !result?.ready) {
          await scheduleRetry(job, 'Building the evidence archive');
          continue;
        }

        await db.query(
          `UPDATE jobs SET status = 'done', error = NULL, updated_at = NOW() WHERE id = $1`,
          [job.id]
        );
        // Only the closure job resolves the document — an archive job must
        // never mark an NCR resolved on its own.
        if (job.job_type === 'resolve' && job.ncr_form_id) {
          await db.query(
            `UPDATE ncr_forms SET status = 'RESOLVED', updated_at = NOW()
             WHERE id = $1 AND status = 'SAVED'`,
            [job.ncr_form_id]
          );
        }
        console.log(`[JOBS] ${job.job_type} #${job.id} done`, result ? '' : '');
      } catch (err) {
        await scheduleRetry(job, String(err.message || err).slice(0, 500), true);
        console.error(`[JOBS] ${job.job_type} #${job.id} attempt failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[JOBS] tick failed:', err.message);
  } finally {
    running = false;
  }
}

// Never let one job run forever.
function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

// Is every channel's durable file there?
function footageComplete(result) {
  // Nothing to follow up on yet (the camera could not be resolved) — keep the
  // job alive, the vehicle may be back on the road later.
  if (result?.skipped) return false;
  const rows = result?.rows;
  // Every channel already has its file.
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return rows.every((r) => r.fileState === 'READY' && r.fileUrl);
}

// Put the job back in the queue, or kill it when it has run out of attempts.
async function scheduleRetry(job, message, isError = false) {
  const attempts = (job.attempts || 0) + 1;
  const isFootage = job.job_type === 'footage';
  const isArchive = job.job_type === 'archive';
  const backoff = isFootage ? FOOTAGE_BACKOFF_MIN : BACKOFF_MIN;
  const maxAttempts = isFootage
    ? FOOTAGE_MAX_ATTEMPTS
    : isArchive
      ? ARCHIVE_MAX_ATTEMPTS
      : MAX_ATTEMPTS;
  // An archive build can take a while (large clips): check every minute.
  const wait = isArchive ? 1 : backoff[Math.min(attempts - 1, backoff.length - 1)];
  const dead = attempts >= maxAttempts;
  await db.query(
    `UPDATE jobs SET status = $2, attempts = $3, error = $4,
       next_retry_at = NOW() + ($5 || ' minutes')::interval, updated_at = NOW()
     WHERE id = $1`,
    [job.id, dead ? 'dead' : 'failed', attempts, String(message || '').slice(0, 500), String(wait)]
  );
  if (dead && isArchive) {
    await db.query(
      `UPDATE ncr_forms SET archive_status = 'FAILED', archive_error = $2, updated_at = NOW()
       WHERE id = $1 AND (archive_url IS NULL OR archive_url = '')`,
      [job.ncr_form_id, String(message || '').slice(0, 500)]
    ).catch(() => {});
  } else if (dead && job.ncr_form_id) {
    await db.query(
      `UPDATE ncr_forms SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [job.ncr_form_id, String(message || '').slice(0, 500)]
    );
  }
  if (dead) {
    console.error(`[JOBS] ${job.job_type} #${job.id} gave up after ${attempts} attempts:`, message);
  } else {
    console.log(
      `[JOBS] ${job.job_type} #${job.id} attempt ${attempts}${isError ? ' failed' : ''}, next in ${wait} min:`,
      message
    );
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
