const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config/config');

const supabase = config.supabaseUrl && config.supabaseServiceRoleKey
  ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
  : null;

const REPORTS_BUCKET = 'reports';

async function uploadDocument(buffer, fileName, contentType) {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await supabase.storage
    .from(REPORTS_BUCKET)
    .upload(fileName, buffer, {
      contentType: contentType || 'application/pdf',
      upsert: false,
    });

  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from(REPORTS_BUCKET)
    .getPublicUrl(fileName);

  return urlData?.publicUrl || null;
}

function publicUrl(fileName) {
  if (!supabase) return null;
  const { data } = supabase.storage.from(REPORTS_BUCKET).getPublicUrl(fileName);
  return data?.publicUrl || null;
}

// ── Private bucket for NCR documents ───────────────────────────────────────
// Uploaded paperwork is only downloadable by signed-in users: the bucket is
// private and every download goes through a short-lived signed URL minted by
// the API after the auth check. No public link is ever stored or returned.
const NCR_DOCUMENTS_BUCKET = 'ncr-documents';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

let privateBucketReady = null;

async function ensurePrivateBucket() {
  if (!supabase) return false;
  if (privateBucketReady) return privateBucketReady;
  privateBucketReady = (async () => {
    try {
      const { data, error } = await supabase.storage.getBucket(NCR_DOCUMENTS_BUCKET);
      if (!error && data) return true;
      const { error: createErr } = await supabase.storage.createBucket(NCR_DOCUMENTS_BUCKET, {
        public: false,
        fileSizeLimit: 25 * 1024 * 1024,
      });
      if (createErr && !/already exists/i.test(createErr.message || '')) {
        console.error('[Storage] Could not create private bucket:', createErr.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Storage] Private bucket check failed:', err.message);
      return false;
    }
  })();
  return privateBucketReady;
}

async function uploadPrivateDocument(buffer, fileName, contentType) {
  if (!supabase) throw new Error('Supabase not configured');
  await ensurePrivateBucket();
  const { error } = await supabase.storage
    .from(NCR_DOCUMENTS_BUCKET)
    .upload(fileName, buffer, {
      contentType: contentType || 'application/pdf',
      upsert: false,
    });
  if (error) throw error;
  return fileName;
}

async function createPrivateDocumentUrl(storagePath, ttlSeconds = SIGNED_URL_TTL_SECONDS, downloadName = null) {
  if (!supabase) return null;
  const { data, error } = await supabase.storage
    .from(NCR_DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, ttlSeconds, downloadName ? { download: downloadName } : undefined);
  if (error) {
    console.error('[Storage] Signed URL failed:', error.message);
    return null;
  }
  return data?.signedUrl || null;
}

/**
 * A short-lived signed UPLOAD url for a private bucket: the browser PUTs the
 * file straight to storage, so large documents never pass through the API
 * body limit. The path is fixed by the caller (scoped to the incident).
 */
async function createPrivateUploadUrl(storagePath, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  if (!supabase) return null;
  await ensurePrivateBucket();
  const { data, error } = await supabase.storage
    .from(NCR_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath, ttlSeconds);
  if (error) {
    console.error('[Storage] Signed upload URL failed:', error.message);
    return null;
  }
  return {
    signedUrl: data?.signedUrl || null,
    token: data?.token || null,
    path: data?.path || storagePath,
  };
}

/**
 * Upload a file straight from disk. Evidence archives are hundreds of MB, so
 * the body is a stream (undici `duplex: 'half'`) instead of a Buffer — the
 * container never holds the whole ZIP in memory.
 */
async function uploadLocalFile(localPath, fileName, contentType) {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('Supabase not configured');
  }
  const encoded = String(fileName)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const url = `${config.supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/${REPORTS_BUCKET}/${encoded}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: fs.createReadStream(localPath),
    duplex: 'half',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase upload HTTP ${res.status}: ${(detail || res.statusText).slice(0, 200)}`);
  }
  return publicUrl(fileName);
}

function localFileNameFor(fileName) {
  return path.basename(fileName);
}

module.exports = {
  uploadDocument,
  uploadLocalFile,
  publicUrl,
  localFileNameFor,
  REPORTS_BUCKET,
  NCR_DOCUMENTS_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  uploadPrivateDocument,
  createPrivateDocumentUrl,
  createPrivateUploadUrl,
  ensurePrivateBucket,
};
