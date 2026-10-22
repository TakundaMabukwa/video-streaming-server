// Evidence archive for an alert group ("apply all media").
//
// Downloads every durable clip (the uploaded MP4 of each channel) and every
// camera screenshot of every detection in the group, zips them together with
// a manifest and uploads the ZIP. The NCR links that ZIP, so the whole
// incident travels with the document.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const archiver = require('archiver');
const db = require('../db');
const syncService = require('./syncService');
const storage = require('../helpers/storage');

const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MEDIA_FETCH_TIMEOUT_MS = 20000;
const MAX_FILE_BYTES = 600 * 1024 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;

const inflight = new Map();

function log(...args) {
  console.log('[ARCHIVE]', ...args);
}

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

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function stamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  return valid.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function safeSegment(value, fallback = 'item') {
  const clean = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

function extensionFor(url, contentType, kind) {
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = String(url || '').toLowerCase();
  }
  const fromUrl = pathname.match(/\.(mp4|mov|avi|flv|jpg|jpeg|png|webp|gif|bmp)$/);
  if (fromUrl) return `.${fromUrl[1] === 'jpeg' ? 'jpg' : fromUrl[1]}`;
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mp4')) return '.mp4';
  if (type.includes('quicktime')) return '.mov';
  if (type.includes('jpeg')) return '.jpg';
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  return kind === 'video' ? '.mp4' : '.jpg';
}

/**
 * Download a URL to disk, following redirects. Camera media is public but the
 * skycamx certificate chain is not on the container, hence rejectUnauthorized.
 */
function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const attempt = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (err) {
        return done(reject, err);
      }
      const mod = parsed.protocol === 'http:' ? http : https;
      const request = mod.get(
        parsed,
        {
          rejectUnauthorized: false,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        },
        (res) => {
          if (
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            return attempt(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return done(reject, new Error(`HTTP ${res.statusCode} for ${target}`));
          }
          const out = fs.createWriteStream(dest);
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_FILE_BYTES) {
              request.destroy();
              out.destroy();
              done(reject, new Error(`file too large (> ${MAX_FILE_BYTES} bytes)`));
            }
          });
          res.on('error', (err) => done(reject, err));
          out.on('error', (err) => done(reject, err));
          out.on('finish', () => done(resolve, { bytes, contentType: res.headers['content-type'] || '' }));
          res.pipe(out);
        }
      );
      request.on('error', (err) => done(reject, err));
      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy(new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`));
      });
    };
    attempt(url, 3);
  });
}

/**
 * Every item that belongs in the archive:
 *   - the uploaded MP4 of each channel (durable, replayable)
 *   - every screenshot the camera stored for each detection
 * Replay `.flv` streams are skipped: they are one-shot, not a file.
 */
async function collectGroupMedia(groupId) {
  const [membersQ, footageQ, pendingQ] = await Promise.all([
    db.query(
      `SELECT id, device_id, device_name, alarm_type, alarm_ts
       FROM alerts WHERE alert_group_id = $1
       ORDER BY alarm_ts ASC NULLS LAST, id ASC`,
      [groupId]
    ),
    db.query(
      `SELECT alert_id, channel_id, file_url, file_start, file_end, alarm_type
       FROM alert_footage
       WHERE alert_group_id = $1 AND file_url IS NOT NULL AND file_url <> ''
       ORDER BY alert_id ASC, channel_id ASC`,
      [groupId]
    ),
    db.query(
      `SELECT alert_id, channel_id, file_state
       FROM alert_footage
       WHERE alert_group_id = $1 AND (file_url IS NULL OR file_url = '')
       ORDER BY alert_id ASC, channel_id ASC`,
      [groupId]
    ),
  ]);

  const members = membersQ.rows;
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const url = String(item.url || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({ ...item, url });
  };

  for (const row of footageQ.rows) {
    add({
      kind: 'video',
      url: row.file_url,
      alertId: row.alert_id,
      channel: row.channel_id,
      alarmType: row.alarm_type,
      capturedAt: row.file_start || null,
      rangeStart: row.file_start || null,
      rangeEnd: row.file_end || null,
    });
  }

  // Anything the sync ever stored for these detections (screenshots are not
  // always returned by the live camera API any more).
  if (members.length > 0) {
    const stored = await db.query(
      `SELECT alert_id, file_url, file_type, created_at
       FROM alert_media WHERE alert_id = ANY($1::text[])`,
      [members.map((m) => m.id)]
    ).catch(() => ({ rows: [] }));
    for (const row of stored.rows) {
      const url = String(row.file_url || '').trim();
      if (!url) continue;
      const type = String(row.file_type || '');
      if (type === '02' && /\.(flv|m3u8|ts)(\?|$)/i.test(url)) continue;
      add({
        kind: type === '02' ? 'video' : 'image',
        url,
        alertId: row.alert_id,
        channel: null,
        alarmType: null,
        capturedAt: row.created_at || null,
      });
    }
  }

  await mapLimit(members, DOWNLOAD_CONCURRENCY, async (member) => {
    try {
      const media = await withTimeout(
        syncService.fetchMediaOnDemand(member),
        MEDIA_FETCH_TIMEOUT_MS,
        'media lookup timed out'
      );
      for (const file of media || []) {
        const type = String(file.file_type || '');
        const url = String(file.file_url || '').trim();
        if (!url) continue;
        // '02' is the live replay stream — not downloadable as a window.
        if (type === '02' && /\.(flv|m3u8|ts)(\?|$)/i.test(url)) continue;
        add({
          kind: type === '02' ? 'video' : 'image',
          url,
          alertId: member.id,
          channel: null,
          alarmType: member.alarm_type,
          capturedAt: file.created_at || member.alarm_ts || null,
        });
      }
    } catch (err) {
      log(`media lookup failed for alert ${member.id}:`, err.message);
    }
  });

  const pending = pendingQ.rows.map((r) => ({
    alertId: r.alert_id,
    channel: r.channel_id,
    state: r.file_state || 'PENDING',
  }));

  return { members, items, pending };
}

async function setStatus(groupId, status, fields = {}) {
  const { rows } = await db.query(
    `INSERT INTO alert_group_archives (alert_group_id, status, requested_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (alert_group_id) DO UPDATE
       SET status = EXCLUDED.status,
           requested_by = COALESCE(EXCLUDED.requested_by, alert_group_archives.requested_by),
           updated_at = NOW()
     RETURNING id, alert_group_id, status, url, error, file_count, byte_size, manifest, created_at, updated_at`,
    [groupId, status, fields.requestedBy || null]
  );
  return rows[0] || null;
}

async function getGroupArchive(groupId) {
  const { rows } = await db.query(
    `SELECT id, alert_group_id, status, url, error, file_count, byte_size, manifest, created_at, updated_at
     FROM alert_group_archives WHERE alert_group_id = $1`,
    [groupId]
  );
  return rows[0] || null;
}

async function markForms(groupId, status, { url = null, error = null } = {}) {
  if (status === 'READY') {
    await db.query(
      `UPDATE ncr_forms
       SET archive_url = $2, archive_status = 'READY', archive_error = NULL, updated_at = NOW()
       WHERE alert_group_id = $1`,
      [groupId, url]
    );
    return;
  }
  await db.query(
    `UPDATE ncr_forms
     SET archive_status = $2, archive_error = $3, updated_at = NOW()
     WHERE alert_group_id = $1 AND (archive_url IS NULL OR archive_url = '')`,
    [groupId, status, error]
  );
}

async function doBuild(groupId, { requestedBy = null } = {}) {
  await setStatus(groupId, 'BUILDING', { requestedBy });
  let workDir = null;
  let zipPath = null;
  try {
    const { members, items, pending } = await collectGroupMedia(groupId);
    if (items.length === 0) {
      throw new Error(
        pending.length > 0
          ? 'The camera has not uploaded any clip for this alert yet'
          : 'No media found for this alert group'
      );
    }

    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `ncr-archive-${groupId}-`));
    zipPath = path.join(workDir, `evidence-group-${groupId}-${stamp()}.zip`);

    const manifest = {
      alertGroupId: groupId,
      generatedAt: new Date().toISOString(),
      alerts: members.map((m) => ({
        alertId: m.id,
        deviceId: m.device_id,
        deviceName: m.device_name,
        alarmType: m.alarm_type,
        alarmTime: m.alarm_ts,
      })),
      files: [],
      pending,
    };

    let totalBytes = 0;
    let index = 0;
    await mapLimit(items, DOWNLOAD_CONCURRENCY, async (item) => {
      index += 1;
      const base = `${String(index).padStart(3, '0')}_${safeSegment(item.alertId, 'alert')}`;
      const tempDest = path.join(workDir, `${base}.part`);
      try {
        const downloaded = await downloadToFile(item.url, tempDest);
        if (totalBytes + downloaded.bytes > MAX_TOTAL_BYTES) {
          throw new Error('archive would exceed the maximum size');
        }
        const ext = extensionFor(item.url, downloaded.contentType, item.kind);
        const folder = item.kind === 'video' ? 'clips' : 'screenshots';
        const channel = item.channel ? `_ch${item.channel}` : '';
        const entryName = `${folder}/${base}${channel}_${stamp(item.capturedAt)}${ext}`;
        const finalPath = path.join(workDir, `${base}${ext}`);
        await fsp.rename(tempDest, finalPath);
        item.downloadedPath = finalPath;
        item.entryName = entryName;
        item.bytes = downloaded.bytes;
        totalBytes += downloaded.bytes;
        manifest.files.push({
          name: entryName,
          kind: item.kind,
          alertId: item.alertId,
          channel: item.channel,
          rangeStart: item.rangeStart || null,
          rangeEnd: item.rangeEnd || null,
          capturedAt: item.capturedAt || null,
          sourceUrl: item.url,
          bytes: downloaded.bytes,
        });
        log(`group ${groupId}: downloaded ${entryName} (${downloaded.bytes} bytes)`);
      } catch (err) {
        await fsp.unlink(tempDest).catch(() => {});
        manifest.pending.push({
          alertId: item.alertId,
          channel: item.channel,
          kind: item.kind,
          url: item.url,
          error: err.message,
        });
        log(`group ${groupId}: skip ${item.url} — ${err.message}`);
      }
    });

    const downloaded = items.filter((item) => item.downloadedPath);
    if (downloaded.length === 0) {
      throw new Error('None of the media files could be downloaded');
    }

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 1 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') log('zip warning:', err.message);
        else reject(err);
      });
      archive.pipe(output);
      for (const item of downloaded) {
        archive.file(item.downloadedPath, { name: item.entryName });
      }
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      archive.finalize();
    });

    const byteSize = (await fsp.stat(zipPath)).size;
    const remoteName = `ncr-archives/group-${groupId}/evidence-${stamp()}.zip`;
    const url = await storage.uploadLocalFile(zipPath, remoteName, 'application/zip');
    if (!url) throw new Error('The archive upload returned no public URL');

    await db.query(
      `UPDATE alert_group_archives
       SET status = 'READY', url = $2, error = NULL, file_count = $3, byte_size = $4,
           manifest = $5::jsonb, updated_at = NOW()
       WHERE alert_group_id = $1`,
      [groupId, url, downloaded.length, byteSize, JSON.stringify(manifest)]
    );
    await markForms(groupId, 'READY', { url });
    log(`group ${groupId}: archive ready (${downloaded.length} files, ${byteSize} bytes)`, url);
    return { ready: true, url, fileCount: downloaded.length, byteSize, manifest };
  } catch (err) {
    const message = String(err.message || err).slice(0, 500);
    await db.query(
      `UPDATE alert_group_archives
       SET status = 'FAILED', error = $2, updated_at = NOW()
       WHERE alert_group_id = $1`,
      [groupId, message]
    ).catch(() => {});
    await markForms(groupId, 'FAILED', { error: message }).catch(() => {});
    log(`group ${groupId}: build failed —`, message);
    throw err;
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Build (or join an in-flight build) for a group. */
async function buildGroupArchive(groupId, opts = {}) {
  const id = Number(groupId);
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid alert group id');
  if (inflight.has(id)) return inflight.get(id);
  const promise = doBuild(id, opts).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}

/** Start the build in the background and return the current row immediately. */
async function requestGroupArchive(groupId, { requestedBy = null, force = false } = {}) {
  const id = Number(groupId);
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid alert group id');
  const existing = await getGroupArchive(id);
  if (existing && !force && existing.status === 'READY' && existing.url) return existing;
  if (existing && !force && existing.status === 'BUILDING' && inflight.has(id)) return existing;

  const row = await setStatus(id, 'BUILDING', { requestedBy });
  buildGroupArchive(id, { requestedBy }).catch(() => {});
  return row || existing;
}

/**
 * Link the group's archive to an NCR: attach now when ready, otherwise keep
 * the NCR waiting and queue the archive job.
 */
async function queueArchiveForForm(ncrFormId, groupId, { requestedBy = null } = {}) {
  const id = Number(groupId);
  const existing = await getGroupArchive(id);
  if (existing?.status === 'READY' && existing.url) {
    await db.query(
      `UPDATE ncr_forms
       SET archive_url = $2, archive_status = 'READY', archive_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [ncrFormId, existing.url]
    );
    return existing;
  }

  await db.query(
    `UPDATE ncr_forms SET archive_status = 'BUILDING', archive_error = NULL, updated_at = NOW()
     WHERE id = $1 AND (archive_url IS NULL OR archive_url = '')`,
    [ncrFormId]
  );

  const pending = await db.query(
    `SELECT id FROM jobs
     WHERE job_type = 'archive' AND status IN ('pending', 'running', 'failed')
       AND COALESCE((payload->>'groupId')::int, alert_group_id) = $1
     LIMIT 1`,
    [id]
  );
  if (pending.rows.length === 0) {
    await db.query(
      `INSERT INTO jobs (job_type, payload, ncr_form_id, alert_group_id)
       VALUES ('archive', $1::jsonb, $2, $3)`,
      [JSON.stringify({ groupId: id, userId: requestedBy || null }), ncrFormId, id]
    );
  }

  requestGroupArchive(id, { requestedBy }).catch((err) => log('request failed:', err.message));
  return existing;
}

module.exports = {
  collectGroupMedia,
  getGroupArchive,
  buildGroupArchive,
  requestGroupArchive,
  queueArchiveForForm,
  markForms,
};
