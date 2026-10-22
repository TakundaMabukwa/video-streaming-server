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

module.exports = { uploadDocument, uploadLocalFile, publicUrl, localFileNameFor, REPORTS_BUCKET };
