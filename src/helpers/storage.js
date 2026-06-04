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

module.exports = { uploadDocument };
