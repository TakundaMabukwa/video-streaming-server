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
CREATE INDEX IF NOT EXISTS idx_alert_groups_device_open ON alert_groups(device_id, resolved, false_alert, last_alert_ts DESC);
`;

const MIGRATIONS_SQL = `
  CREATE INDEX IF NOT EXISTS idx_alert_groups_device_open ON alert_groups(device_id, resolved, false_alert, last_alert_ts DESC);

  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT FALSE;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS false_alert BOOLEAN DEFAULT FALSE;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notes TEXT;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '[]'::jsonb;

  CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON alerts(device_id, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_type_ts ON alerts(alarm_type, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_media_alert_file ON alert_media(alert_id, file_url);

  -- Backfill alert_groups from existing alerts (one-time)
  -- Only backfills alarm types that STILL EXIST as active alert_definitions;
  -- a definition deleted in Alert Config must never be resurrected here on a
  -- later boot (the legacy alerts archive still holds its old rows).
  INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, status, resolved, false_alert, notes, documents, created_at, updated_at)
  SELECT
    LOWER(CONCAT(a.device_id, ':', a.alarm_type)) AS group_key,
    a.device_id,
    a.device_name,
    a.alarm_type,
    a.alarm_text,
    COUNT(*) AS count,
    (array_agg(a.id ORDER BY a.alarm_ts DESC NULLS LAST))[1] AS last_alert_id,
    MAX(a.alarm_ts) AS last_alert_ts,
    (array_agg(a.lat ORDER BY a.alarm_ts DESC NULLS LAST))[1] AS lat,
    (array_agg(a.lon ORDER BY a.alarm_ts DESC NULLS LAST))[1] AS lon,
    'new' AS status,
    bool_or(a.resolved) AS resolved,
    bool_or(a.false_alert) AS false_alert,
    NULL AS notes,
    '[]'::jsonb AS documents,
    NOW() AS created_at,
    NOW() AS updated_at
  FROM alerts a
  JOIN alert_definitions d ON lower(d.name) = lower(a.alarm_type) AND d.is_active = true
    AND (
      -- genuinely global: no per-CC override rows at all
      NOT EXISTS (
        SELECT 1 FROM alert_definition_overrides o
        JOIN cost_centers cc ON cc.id = o.cost_center_id
        WHERE o.alert_definition_id = d.id AND cc.is_active IS DISTINCT FROM false
      )
      OR
      -- in-set for at least one active cost center
      EXISTS (
        SELECT 1 FROM alert_definition_overrides o
        JOIN cost_centers cc ON cc.id = o.cost_center_id
        WHERE o.alert_definition_id = d.id AND cc.is_active IS DISTINCT FROM false
          AND o.is_active IS DISTINCT FROM false
      )
    )
  GROUP BY a.device_id, a.device_name, a.alarm_type, a.alarm_text
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
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
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
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'alert_definitions_signal_code_unique'
      AND conrelid = 'alert_definitions'::regclass
    ) THEN
      ALTER TABLE alert_definitions ADD CONSTRAINT alert_definitions_signal_code_unique UNIQUE (signal_code);
    END IF;
  END $$;
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

  -- Add columns to driver_config_criteria
  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS nrc_deduction BOOLEAN DEFAULT FALSE;
  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS incidents_threshold INTEGER DEFAULT 1;
  CREATE INDEX IF NOT EXISTS idx_driver_config_criteria_nrc ON driver_config_criteria(nrc_deduction);

  -- Phase 1: New deduction model columns
  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS deduction_per_alert NUMERIC DEFAULT 10;
  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS deduction_with_ncr NUMERIC DEFAULT 0;
  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS ncr_threshold INTEGER DEFAULT 3;

  -- Phase 3: Cost center config system
  -- Local mirror of Supabase cost_centers table, synced at midnight
  CREATE TABLE IF NOT EXISTS cost_centers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_cost_centers_name ON cost_centers(name);
  CREATE INDEX IF NOT EXISTS idx_cost_centers_code ON cost_centers(code);

  -- RTMS rules configuration
  CREATE TABLE IF NOT EXISTS rtms_rules (
    id SERIAL PRIMARY KEY,
    module TEXT NOT NULL,
    rule_name TEXT NOT NULL UNIQUE,
    system_constraint TEXT DEFAULT '',
    audit_focus TEXT DEFAULT '',
    max_value NUMERIC DEFAULT 0,
    min_value NUMERIC DEFAULT 0,
    unit TEXT DEFAULT '',
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_rtms_rules_module ON rtms_rules(module);

  -- Driver scoring: per-vehicle/driver score tracking
  CREATE TABLE IF NOT EXISTS driver_scoring (
    id SERIAL PRIMARY KEY,
    registration_number TEXT,
    fleet_number TEXT NOT NULL UNIQUE,
    driver TEXT,
    score NUMERIC DEFAULT 100 CHECK (score >= 0),
    alert_types JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_driver_scoring_fleet ON driver_scoring(fleet_number);
  CREATE INDEX IF NOT EXISTS idx_driver_scoring_registration ON driver_scoring(registration_number);

  -- Fleet vehicles (synced from Supabase)
  CREATE TABLE IF NOT EXISTS fleet_vehicles (
    fleet_number TEXT,
    registration_number TEXT,
    make TEXT,
    model TEXT,
    cost_center TEXT,
    last_synced TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(fleet_number, registration_number)
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_fleet ON fleet_vehicles(fleet_number);

  -- cost_center_id columns on config tables (NULL = global/default config)
  ALTER TABLE alert_definitions ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  ALTER TABLE alert_group_configs ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  ALTER TABLE rtms_rules ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;

  CREATE INDEX IF NOT EXISTS idx_alert_definitions_cc ON alert_definitions(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_alert_group_configs_cc ON alert_group_configs(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_driver_config_criteria_cc ON driver_config_criteria(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_rtms_rules_cc ON rtms_rules(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_cc ON fleet_vehicles(cost_center_id);

  -- Track cost center per driver scoring / fleet vehicle
  ALTER TABLE driver_scoring ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_driver_scoring_cc ON driver_scoring(cost_center_id);

  -- Replace rtms_rules single-column UNIQUE on rule_name with composite (rule_name, cost_center_id)
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'rtms_rules_rule_name_key'
      AND conrelid = 'rtms_rules'::regclass
    ) THEN
      ALTER TABLE rtms_rules DROP CONSTRAINT rtms_rules_rule_name_key;
    END IF;
  END $$;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'rtms_rules_cc_unique'
      AND conrelid = 'rtms_rules'::regclass
    ) THEN
      ALTER TABLE rtms_rules ADD CONSTRAINT rtms_rules_cc_unique UNIQUE (rule_name, cost_center_id);
    END IF;
  END $$;

  -- Replace the single-column UNIQUE on driver_config_criteria.name with a composite
  -- (name, cost_center_id) so per-cost-center overrides are allowed.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'driver_config_criteria_name_key'
      AND conrelid = 'driver_config_criteria'::regclass
    ) THEN
      ALTER TABLE driver_config_criteria DROP CONSTRAINT driver_config_criteria_name_key;
    END IF;
  END $$;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'driver_config_criteria_cc_unique'
      AND conrelid = 'driver_config_criteria'::regclass
    ) THEN
      ALTER TABLE driver_config_criteria
        ADD CONSTRAINT driver_config_criteria_cc_unique UNIQUE (name, cost_center_id);
    END IF;
  END $$;

  -- RTMS driving sessions (engine on/off tracking)
  CREATE TABLE IF NOT EXISTS rtms_driving_sessions (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    fleet_number TEXT,
    registration_number TEXT,
    engine_on_at TIMESTAMPTZ NOT NULL,
    engine_off_at TIMESTAMPTZ,
    duration_minutes NUMERIC GENERATED ALWAYS AS (
      CASE WHEN engine_off_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (engine_off_at - engine_on_at)) / 60
        ELSE NULL
      END
    ) STORED,
    alert_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_rtms_sessions_device ON rtms_driving_sessions(device_id);
  CREATE INDEX IF NOT EXISTS idx_rtms_sessions_active ON rtms_driving_sessions(engine_off_at) WHERE engine_off_at IS NULL;
  ALTER TABLE rtms_driving_sessions ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_rtms_sessions_cc ON rtms_driving_sessions(cost_center_id);

  -- Geotab devices
  CREATE TABLE IF NOT EXISTS geotab_devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    fleet_number TEXT,
    license_plate TEXT,
    device_type TEXT,
    vin TEXT,
    serial_number TEXT,
    fuel_tank_capacity DOUBLE PRECISION,
    timezone TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    active_from TIMESTAMPTZ,
    active_to TIMESTAMPTZ,
    groups JSONB DEFAULT '[]',
    raw_data JSONB DEFAULT '{}',
    last_synced TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_geotab_devices_fleet ON geotab_devices(fleet_number);
  CREATE INDEX IF NOT EXISTS idx_geotab_devices_plate ON geotab_devices(license_plate);

  -- Geotab groups
  CREATE TABLE IF NOT EXISTS geotab_groups (
    id TEXT PRIMARY KEY,
    name TEXT,
    parent_id TEXT,
    is_global BOOLEAN DEFAULT FALSE,
    raw_data JSONB DEFAULT '{}',
    last_synced TIMESTAMPTZ DEFAULT NOW()
  );

  -- Geotab exception rules
  CREATE TABLE IF NOT EXISTS geotab_exception_rules (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    raw_data JSONB DEFAULT '{}',
    last_synced TIMESTAMPTZ DEFAULT NOW()
  );

  -- Geotab diagnostics
  CREATE TABLE IF NOT EXISTS geotab_diagnostics (
    id TEXT PRIMARY KEY,
    name TEXT,
    unit TEXT,
    raw_data JSONB DEFAULT '{}',
    last_synced TIMESTAMPTZ DEFAULT NOW()
  );

  -- Telematics events from Geotab
  CREATE TABLE IF NOT EXISTS telematics_events (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    vehicle_id TEXT,
    plate TEXT,
    event_type TEXT NOT NULL,
    event_code TEXT,
    severity TEXT DEFAULT 'LOW',
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    address TEXT,
    driver_name TEXT,
    description TEXT,
    raw_data JSONB DEFAULT '{}'::jsonb,
    event_time TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_telematics_events_device ON telematics_events(device_id);
  CREATE INDEX IF NOT EXISTS idx_telematics_events_type ON telematics_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_telematics_events_time ON telematics_events(event_time DESC);
  CREATE INDEX IF NOT EXISTS idx_telematics_events_plate ON telematics_events(plate);

  -- Add missing columns to telematics_events
  ALTER TABLE telematics_events ADD COLUMN IF NOT EXISTS license_plate TEXT;
  ALTER TABLE telematics_events ADD COLUMN IF NOT EXISTS fleet_number TEXT;
  ALTER TABLE telematics_events ADD COLUMN IF NOT EXISTS distance DOUBLE PRECISION;
  ALTER TABLE telematics_events ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
  ALTER TABLE telematics_events ADD COLUMN IF NOT EXISTS zone_name TEXT;
  CREATE INDEX IF NOT EXISTS idx_telematics_events_device_time ON telematics_events(device_id, event_time);

  -- Add source_type to alerts and alert_groups (video vs telematics)
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'video';
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'video';
  CREATE INDEX IF NOT EXISTS idx_alerts_source_type ON alerts(source_type);
  CREATE INDEX IF NOT EXISTS idx_alert_groups_source_type ON alert_groups(source_type);

  -- Follow-up: temporarily lower severity for 15 minutes
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS follow_up BOOLEAN DEFAULT FALSE;
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMPTZ;
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS original_severity TEXT;

  -- Add missing columns to vehicle_status
  CREATE TABLE IF NOT EXISTS vehicle_status (
    device_id TEXT PRIMARY KEY,
    plate TEXT,
    license_plate TEXT,
    fleet_number TEXT,
    engine_on BOOLEAN,
    ignition_on BOOLEAN,
    speed DOUBLE PRECISION,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    last_log_time TIMESTAMPTZ,
    last_update TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS speed DOUBLE PRECISION;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS last_log_time TIMESTAMPTZ;
  -- Real Geotab device state (syncDeviceStatus + syncIgnitionStatus):
  -- is_device_communicating / online-since come from DeviceStatusInfo;
  -- status_seen marks the last real StatusData sample (ignition/engine RPM).
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS is_online BOOLEAN;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS online_since TIMESTAMPTZ;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS status_seen TIMESTAMPTZ;
  -- DeviceStatusInfo driving state tracking
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS is_driving BOOLEAN;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS driving_since TIMESTAMPTZ;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS current_state_duration INTERVAL;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS max_speed_this_session DOUBLE PRECISION DEFAULT 0;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS speed_85_alerted BOOLEAN DEFAULT FALSE;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS speed_90_alerted BOOLEAN DEFAULT FALSE;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS fatigue_alerted_thresholds TEXT DEFAULT '[]';

  -- Geotab zones
  CREATE TABLE IF NOT EXISTS geotab_zones (
    id TEXT PRIMARY KEY,
    name TEXT,
    points JSONB DEFAULT '[]',
    zone_types JSONB DEFAULT '[]',
    comment TEXT,
    is_high_risk BOOLEAN DEFAULT FALSE,
    is_no_go BOOLEAN DEFAULT FALSE,
    raw_data JSONB DEFAULT '{}',
    last_synced TIMESTAMPTZ DEFAULT NOW()
  );

  -- High risk zone entries
  CREATE TABLE IF NOT EXISTS high_risk_zone_entries (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    fleet_number TEXT,
    license_plate TEXT,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    entry_time TIMESTAMPTZ NOT NULL,
    exit_time TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_high_risk_zone_entries_device ON high_risk_zone_entries(device_id);
  CREATE INDEX IF NOT EXISTS idx_high_risk_zone_entries_time ON high_risk_zone_entries(entry_time DESC);
  CREATE INDEX IF NOT EXISTS idx_high_risk_zone_entries_active ON high_risk_zone_entries(is_active) WHERE is_active = TRUE;

  -- Zone stop events (persistent stop tracking for high-risk/no-stopping zones)
  CREATE TABLE IF NOT EXISTS zone_stop_events (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    fleet_number TEXT,
    license_plate TEXT,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    zone_type TEXT NOT NULL,           -- 'high_risk' | 'no_stopping'
    stop_start TIMESTAMPTZ NOT NULL,
    stop_end TIMESTAMPTZ,
    immediate_alert_sent BOOLEAN DEFAULT FALSE,
    minute_alert_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_zone_stop_active ON zone_stop_events(device_id, stop_end) WHERE stop_end IS NULL;
  CREATE INDEX IF NOT EXISTS idx_zone_stop_zone ON zone_stop_events(zone_id, stop_start);

  -- Driving sessions (isDriving transitions from DeviceStatusInfo)
  CREATE TABLE IF NOT EXISTS driving_sessions (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    fleet_number TEXT,
    registration_number TEXT,
    driving_started_at TIMESTAMPTZ NOT NULL,
    driving_ended_at TIMESTAMPTZ,
    duration_minutes NUMERIC GENERATED ALWAYS AS (
      CASE WHEN driving_ended_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (driving_ended_at - driving_started_at)) / 60
        ELSE NULL
      END
    ) STORED,
    cost_center_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_driving_sessions_device ON driving_sessions(device_id);
  CREATE INDEX IF NOT EXISTS idx_driving_sessions_active ON driving_sessions(driving_ended_at) WHERE driving_ended_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_driving_sessions_cc ON driving_sessions(cost_center_id);

  -- Vehicle log records (GPS positions)
  CREATE TABLE IF NOT EXISTS vehicle_log_records (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    heading DOUBLE PRECISION,
    odometer DOUBLE PRECISION,
    record_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, record_time)
  );

  CREATE INDEX IF NOT EXISTS idx_vehicle_log_records_device_time ON vehicle_log_records(device_id, record_time);

  -- Composite index for fast unresolved alert_groups lookup
  CREATE INDEX IF NOT EXISTS idx_alert_groups_resolved_ts ON alert_groups(resolved, last_alert_ts DESC) WHERE resolved = FALSE;

  -- Index for vehicle-alerts query on unresolved alerts
  CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts(device_id, alarm_ts DESC) WHERE resolved = FALSE AND false_alert = FALSE;
  CREATE INDEX IF NOT EXISTS idx_alerts_unresolved_name ON alerts(device_name, alarm_ts DESC) WHERE resolved = FALSE AND false_alert = FALSE;

  -- NCR / Incident Register
  CREATE SEQUENCE IF NOT EXISTS incident_no_seq;

  CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_no TEXT UNIQUE DEFAULT ('INC-' || to_char(now(),'YYYY') || '-' || lpad(nextval('incident_no_seq')::bigint::text, 4, '0')),
    alert_id TEXT UNIQUE,
    alert_group_key TEXT,
    alarm_type TEXT,
    source_type TEXT DEFAULT 'telematics',
    device_id TEXT,
    fleet_number TEXT,
    cost_center_id INTEGER,
    week INTEGER,
    shift TEXT,
    incident_date DATE,
    incident_time TIME,
    controller TEXT,
    driver_name TEXT,
    contact_number TEXT,
    id_number TEXT,
    division TEXT,
    infringement TEXT,
    infringement_detail TEXT,
    action_taken TEXT,
    outcome TEXT,
    notes TEXT,
    document_link TEXT,
    document_type TEXT,
    status TEXT DEFAULT 'OPEN',
    filled_by TEXT,
    filled_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_by TEXT,
    resolved_at TIMESTAMPTZ,
    closure_type TEXT,
    deduction_applied NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_incidents_status_date ON incidents(status, incident_date DESC);
  CREATE INDEX IF NOT EXISTS idx_incidents_cc_date ON incidents(cost_center_id, incident_date DESC);
  CREATE INDEX IF NOT EXISTS idx_incidents_fleet ON incidents(fleet_number);

  -- Config Groups: allow multiple cost centers to share the same driver config criteria
  CREATE TABLE IF NOT EXISTS config_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS config_group_members (
    group_id INTEGER NOT NULL REFERENCES config_groups(id) ON DELETE CASCADE,
    cost_center_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, cost_center_id)
  );

  CREATE INDEX IF NOT EXISTS idx_config_group_members_cc ON config_group_members(cost_center_id);

  ALTER TABLE driver_config_criteria ADD COLUMN IF NOT EXISTS config_group_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_driver_config_criteria_group ON driver_config_criteria(config_group_id);

  -- Update unique constraint to include config_group_id
  DO $$
  BEGIN
    -- Drop old constraint if it still exists
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'driver_config_criteria_cc_unique'
      AND conrelid = 'driver_config_criteria'::regclass
    ) THEN
      ALTER TABLE driver_config_criteria
        DROP CONSTRAINT driver_config_criteria_cc_unique;
    END IF;

    -- Add new constraint only if it doesn't exist
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'driver_config_criteria_scope_unique'
      AND conrelid = 'driver_config_criteria'::regclass
    ) THEN
      ALTER TABLE driver_config_criteria
        ADD CONSTRAINT driver_config_criteria_scope_unique UNIQUE (name, config_group_id, cost_center_id);
    END IF;
  END $$;

  -- ============================================================
  -- Alert Definition Overrides: separate table for CC-specific config
  -- ============================================================
  CREATE TABLE IF NOT EXISTS alert_definition_overrides (
    id SERIAL PRIMARY KEY,
    alert_definition_id INTEGER NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
    cost_center_id INTEGER NOT NULL,
    severity TEXT,
    description TEXT,
    is_active BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(alert_definition_id, cost_center_id)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_def_overrides_cc ON alert_definition_overrides(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_alert_def_overrides_def ON alert_definition_overrides(alert_definition_id);

  -- Migrate existing CC-specific rows from alert_definitions into overrides
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'alert_definitions' AND column_name = 'cost_center_id'
    ) THEN
      -- Insert CC-specific data into overrides table
      INSERT INTO alert_definition_overrides (alert_definition_id, cost_center_id, severity, description, is_active)
      SELECT id, cost_center_id, severity, description, is_active
      FROM alert_definitions
      WHERE cost_center_id IS NOT NULL
      ON CONFLICT (alert_definition_id, cost_center_id) DO NOTHING;

      -- Drop cost_center_id from alert_definitions (no longer needed)
      ALTER TABLE alert_definitions DROP COLUMN IF EXISTS cost_center_id;
      DROP INDEX IF EXISTS idx_alert_definitions_cc;
    END IF;
  END $$;

  -- Same pattern for alert_group_configs
  CREATE TABLE IF NOT EXISTS alert_group_config_overrides (
    id SERIAL PRIMARY KEY,
    group_config_id INTEGER NOT NULL REFERENCES alert_group_configs(id) ON DELETE CASCADE,
    cost_center_id INTEGER NOT NULL,
    severity TEXT,
    description TEXT,
    is_active BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_config_id, cost_center_id)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_grp_overrides_cc ON alert_group_config_overrides(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_alert_grp_overrides_grp ON alert_group_config_overrides(group_config_id);

  -- Migrate existing CC-specific rows from alert_group_configs into overrides
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'alert_group_configs' AND column_name = 'cost_center_id'
    ) THEN
      INSERT INTO alert_group_config_overrides (group_config_id, cost_center_id, severity, description, is_active)
      SELECT id, cost_center_id, severity, description, is_active
      FROM alert_group_configs
      WHERE cost_center_id IS NOT NULL
      ON CONFLICT (group_config_id, cost_center_id) DO NOTHING;

      ALTER TABLE alert_group_configs DROP COLUMN IF EXISTS cost_center_id;
      DROP INDEX IF EXISTS idx_alert_group_configs_cc;
    END IF;
  END $$;

  -- ============================================================
  -- Escalation Groups: contact people per cost center and alert.
  -- Escalation group = a named set of contacts (emails) attached to
  -- one cost center, triggered for whichever alerts are linked.
  -- ============================================================
  CREATE TABLE IF NOT EXISTS escalation_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    cost_center_id INTEGER,
    description TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, cost_center_id)
  );
  CREATE INDEX IF NOT EXISTS idx_escalation_groups_cc ON escalation_groups(cost_center_id);

  CREATE TABLE IF NOT EXISTS escalation_group_members (
    id SERIAL PRIMARY KEY,
    escalation_group_id INTEGER NOT NULL REFERENCES escalation_groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_escalation_members_group ON escalation_group_members(escalation_group_id);

  -- Link each escalation group to specific alert definitions (the individual alerts).
  -- This supersedes an earlier version that linked to alert_group_configs; drop that
  -- old empty table if present so the new FK-to-alert_definitions takes effect.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'escalation_group_alert_groups'
        AND column_name = 'alert_group_config_id'
    ) THEN
      DROP TABLE escalation_group_alert_groups;
    END IF;
  END $$;

  CREATE TABLE IF NOT EXISTS escalation_group_alert_groups (
    escalation_group_id INTEGER NOT NULL REFERENCES escalation_groups(id) ON DELETE CASCADE,
    alert_definition_id INTEGER NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
    PRIMARY KEY (escalation_group_id, alert_definition_id)
  );
  CREATE INDEX IF NOT EXISTS idx_escalation_alertgroups_grp ON escalation_group_alert_groups(escalation_group_id);

  -- Repair requests
  CREATE TABLE IF NOT EXISTS repair_requests (
    id SERIAL PRIMARY KEY,
    alert_id TEXT,
    fleet_number TEXT,
    registration TEXT,
    device_id TEXT,
    cost_center_id INTEGER,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_by TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    available_at TIMESTAMPTZ,
    issue_description TEXT,
    job_description TEXT,
    priority TEXT DEFAULT 'medium',
    account_code TEXT DEFAULT 'SRS-0001',
    external_job_number TEXT,
    external_job_type TEXT,
    external_status TEXT DEFAULT 'pending',
    external_response JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_repair_requests_fleet ON repair_requests(fleet_number);
  CREATE INDEX IF NOT EXISTS idx_repair_requests_status ON repair_requests(status);
  CREATE INDEX IF NOT EXISTS idx_repair_requests_ext_job ON repair_requests(external_job_number);

  -- Repair requests: Solflo external job integration columns
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS contact_name TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS contact_phone TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS contact_email TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS issue_description TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS job_description TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium';
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS account_code TEXT DEFAULT 'SRS-0001';
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS external_job_number TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS external_job_type TEXT;
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS external_status TEXT DEFAULT 'pending';
  ALTER TABLE repair_requests ADD COLUMN IF NOT EXISTS external_response JSONB DEFAULT '{}'::jsonb;
  CREATE INDEX IF NOT EXISTS idx_repair_requests_ext_job ON repair_requests(external_job_number);

  -- STRICT CC MODEL backfill: every alert definition belongs to every active
  -- cost center's set unless explicitly removed. Inserts missing overrides,
  -- copying the base severity/description. Idempotent (ON CONFLICT DO NOTHING),
  -- never overwrites existing per-CC customizations.
  -- REMOVALS ARE SOFT (is_active = FALSE, see alertConfigController): removed
  -- rows still exist, so ON CONFLICT skips them and deletions persist across
  -- restarts. Readers must filter o.is_active IS DISTINCT FROM false.
  INSERT INTO alert_definition_overrides (alert_definition_id, cost_center_id, severity, description, is_active)
  SELECT d.id, cc.id, d.severity, d.description, NULL
  FROM alert_definitions d
  CROSS JOIN cost_centers cc
  WHERE cc.is_active IS DISTINCT FROM false
  ON CONFLICT (alert_definition_id, cost_center_id) DO NOTHING;
`;

async function initializeDatabase() {
  await query(SCHEMA_SQL);
  console.log('[DB] Schema initialized successfully');
  await query(MIGRATIONS_SQL);
  console.log('[DB] Migrations applied successfully');
}

module.exports = { initializeDatabase };
