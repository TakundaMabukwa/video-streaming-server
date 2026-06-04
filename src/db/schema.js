const { query } = require('./pool');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    device_name TEXT,
    alarm_type TEXT NOT NULL,
    alarm_ts TIMESTAMPTZ,
    alarm_ts_end TIMESTAMPTZ,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    alarm_text TEXT,
    serial_no TEXT,
    fence_id TEXT,
    alarm_extension TEXT,
    status TEXT DEFAULT 'new',
    resolved BOOLEAN DEFAULT FALSE,
    false_alert BOOLEAN DEFAULT FALSE,
    notes TEXT,
    documents JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_media (
    id SERIAL PRIMARY KEY,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    file_type TEXT,
    file_size DOUBLE PRECISION,
    device_name TEXT,
    alarm_type TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_device_id ON alerts(device_id);
CREATE INDEX IF NOT EXISTS idx_alerts_alarm_type ON alerts(alarm_type);
CREATE INDEX IF NOT EXISTS idx_alerts_alarm_ts ON alerts(alarm_ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_media_alert_id ON alert_media(alert_id);
`;

const MIGRATIONS_SQL = `
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT FALSE;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS false_alert BOOLEAN DEFAULT FALSE;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notes TEXT;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '[]'::jsonb;

  CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON alerts(device_id, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_type_ts ON alerts(alarm_type, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_media_alert_file ON alert_media(alert_id, file_url);
`;

async function initializeDatabase() {
  await query(SCHEMA_SQL);
  console.log('[DB] Schema initialized successfully');
  await query(MIGRATIONS_SQL);
  console.log('[DB] Migrations applied successfully');
}

module.exports = { initializeDatabase };
