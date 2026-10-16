// NCR escalation email outbox sweeper: delivers queued emails in the
// background with backoff so SMTP latency never blocks the NCR save flow.
const db = require('../db');

let timer = null;
const SWEEP_MS = 30000;
const MAX_ATTEMPTS = 8;

function emailServiceUrl() {
  const raw = String(process.env.EMAIL_SERVICE_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.port) u.port = '9000';
    return `${u.origin}/api/send-srs-ncr`;
  } catch {
    return null;
  }
}

async function sweepOnce() {
  const url = emailServiceUrl();
  if (!url) return;
  let rows = [];
  try {
    const r = await db.query(
      `UPDATE ncr_email_outbox SET status = 'sending'
       WHERE id IN (
         SELECT id FROM ncr_email_outbox
         WHERE status IN ('pending', 'failed')
           AND attempts < $1
           AND next_retry_at <= NOW()
         ORDER BY created_at ASC
         LIMIT 10
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, to_addrs, subject, html, attempts`,
      [MAX_ATTEMPTS]
    );
    rows = r.rows;
  } catch (err) {
    console.error('[NCR-OUTBOX] claim failed:', err.message);
    return;
  }
  for (const row of rows) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: row.to_addrs, subject: row.subject, html: row.html }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.success) {
        await db.query(`UPDATE ncr_email_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1`, [row.id]);
        console.log(`[NCR-OUTBOX] sent #${row.id} to ${(row.to_addrs || []).length} recipient(s)`);
      } else {
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
    } catch (err) {
      const attempts = (row.attempts || 0) + 1;
      const backoffMin = Math.min(120, 2 ** attempts);
      const dead = attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE ncr_email_outbox SET status = $2, attempts = $3, last_error = $4,
           next_retry_at = NOW() + ($5 || ' minutes')::interval WHERE id = $1`,
        [row.id, dead ? 'dead' : 'failed', attempts, String(err.message || err).slice(0, 500), String(backoffMin)]
      ).catch(() => {});
      console.error(`[NCR-OUTBOX] #${row.id} attempt ${attempts} failed: ${err.message}`);
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => sweepOnce().catch((e) => console.error('[NCR-OUTBOX] sweep error:', e.message)), SWEEP_MS);
  sweepOnce().catch(() => {});
  console.log('[NCR-OUTBOX] sweeper started (every 30s)');
}

module.exports = { start, sweepOnce };
