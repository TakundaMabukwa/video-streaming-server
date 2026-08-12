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

CREATE TABLE IF NOT EXISTS alert_groups (
    id SERIAL PRIMARY KEY,
    group_key TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    alarm_type TEXT NOT NULL,
    alarm_text TEXT,
    count INTEGER DEFAULT 1,
    last_alert_id TEXT NOT NULL,
    last_alert_ts TIMESTAMPTZ,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    status TEXT DEFAULT 'new',
    resolved BOOLEAN DEFAULT FALSE,
    false_alert BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    notes TEXT,
    documents JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_groups_device ON alert_groups(device_id);
CREATE INDEX IF NOT EXISTS idx_alert_groups_type ON alert_groups(alarm_type);
CREATE INDEX IF NOT EXISTS idx_alert_groups_ts ON alert_groups(last_alert_ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_groups_key ON alert_groups(group_key);
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

  -- Backfill alert_groups from existing alerts (one-time)
  INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, status, resolved, false_alert, notes, documents, created_at, updated_at)
  SELECT
    LOWER(CONCAT(device_id, ':', alarm_type)) AS group_key,
    device_id,
    device_name,
    alarm_type,
    alarm_text,
    COUNT(*) AS count,
    (array_agg(id ORDER BY alarm_ts DESC NULLS LAST))[1] AS last_alert_id,
    MAX(alarm_ts) AS last_alert_ts,
    (array_agg(lat ORDER BY alarm_ts DESC NULLS LAST))[1] AS lat,
    (array_agg(lon ORDER BY alarm_ts DESC NULLS LAST))[1] AS lon,
    'new' AS status,
    bool_or(resolved) AS resolved,
    bool_or(false_alert) AS false_alert,
    NULL AS notes,
    '[]'::jsonb AS documents,
    NOW() AS created_at,
    NOW() AS updated_at
  FROM alerts
  GROUP BY device_id, device_name, alarm_type, alarm_text
  ON CONFLICT (group_key) DO NOTHING;

  -- Add resolved_at / resolved_by columns to alert_groups
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS resolved_by TEXT;

  -- Alert definitions: custom alert types users can create
  CREATE TABLE IF NOT EXISTS alert_definitions (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('telematics', 'video')),
    description TEXT DEFAULT '',
    signal_code TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Alert group configs: user-defined groupings of alert definitions with severity
  CREATE TABLE IF NOT EXISTS alert_group_configs (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 10),
    description TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Junction: which alert definitions belong to which group config
  CREATE TABLE IF NOT EXISTS alert_group_config_members (
    id SERIAL PRIMARY KEY,
    group_config_id INTEGER NOT NULL REFERENCES alert_group_configs(id) ON DELETE CASCADE,
    alert_definition_id INTEGER NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_config_id, alert_definition_id)
  );

  CREATE INDEX IF NOT EXISTS idx_alert_definitions_category ON alert_definitions(category);
  CREATE INDEX IF NOT EXISTS idx_alert_group_configs_severity ON alert_group_configs(severity);
  CREATE INDEX IF NOT EXISTS idx_alert_group_config_members_group ON alert_group_config_members(group_config_id);

  -- Migrate severity from INTEGER to TEXT for alert_group_configs (idempotent)
  DO $$
  BEGIN
    -- Check if severity column is INTEGER type
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'alert_group_configs'
      AND column_name = 'severity'
      AND data_type = 'integer'
    ) THEN
      -- Add temporary column
      ALTER TABLE alert_group_configs ADD COLUMN severity_text TEXT DEFAULT 'MEDIUM';
      -- Copy values
      UPDATE alert_group_configs SET severity_text = CASE
        WHEN severity <= 2 THEN 'LOW'
        WHEN severity <= 4 THEN 'MEDIUM'
        WHEN severity <= 7 THEN 'HIGH'
        ELSE 'CRITICAL'
      END WHERE severity_text IS NULL;
      -- Drop old column and rename
      ALTER TABLE alert_group_configs DROP COLUMN severity;
      ALTER TABLE alert_group_configs RENAME COLUMN severity_text TO severity;
      ALTER TABLE alert_group_configs ALTER COLUMN severity SET DEFAULT 'MEDIUM';
      ALTER TABLE alert_group_configs ALTER COLUMN severity SET NOT NULL;
    END IF;
  END $$;

  -- Add severity to alert_definitions if not exists (idempotent)
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'alert_definitions'
      AND column_name = 'severity'
    ) THEN
      ALTER TABLE alert_definitions ADD COLUMN severity TEXT DEFAULT 'MEDIUM';
      ALTER TABLE alert_definitions ALTER COLUMN severity SET NOT NULL;
    END IF;
  END $$;

  -- Driver config criteria: driver behavior monitoring configuration
  CREATE TABLE IF NOT EXISTS driver_config_criteria (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    selected_weighting NUMERIC DEFAULT 10,
    actual_weighting NUMERIC DEFAULT 10,
    risk_tiers INTEGER DEFAULT 4,
    no_incidents INTEGER DEFAULT 0,
    statuses TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_driver_config_criteria_name ON driver_config_criteria(name);
`;

async function initializeDatabase() {
  await query(SCHEMA_SQL);
  console.log('[DB] Schema initialized successfully');
  await query(MIGRATIONS_SQL);
  console.log('[DB] Migrations applied successfully');
}

module.exports = { initializeDatabase };
