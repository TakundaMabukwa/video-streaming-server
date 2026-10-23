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
    speed DOUBLE PRECISION,
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

  -- combo_state marks a detection that is being held back by an enabled
  -- AND-combination alert group. Declared here (not just in the migrations
  -- block) because the backfill below reads it.
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS combo_state TEXT;

  CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON alerts(device_id, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_type_ts ON alerts(alarm_type, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_media_alert_file ON alert_media(alert_id, file_url);

  -- Backfill alert_groups from existing alerts (one-time)
  -- Only backfills alarm types that STILL EXIST as active alert_definitions;
  -- a definition deleted in Alert Config must never be resurrected here on a
  -- later boot (the legacy alerts archive still holds its old rows).
  INSERT INTO alert_groups (group_key, device_id, device_name, alarm_type, alarm_text, count, last_alert_id, last_alert_ts, lat, lon, status, resolved, false_alert, notes, documents, source_type, created_at, updated_at)
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
    COALESCE(a.source_type, 'video') AS source_type,
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
  WHERE NOT EXISTS (
    -- Never resurrect a twin next to a live group: if the device+type already
    -- has an open, genuine group, the backfill skips it (this also keeps the
    -- one-live-group unique index satisfiable on every boot).
    SELECT 1 FROM alert_groups g
    WHERE g.device_id = a.device_id
      AND lower(g.alarm_type) = lower(a.alarm_type)
      AND COALESCE(g.source_type, 'video') = COALESCE(a.source_type, 'video')
      AND g.resolved = FALSE AND g.false_alert = FALSE
  )
  -- A detection held back by a combo must never be backfilled into a group on
  -- a restart: it only becomes an alert once the whole set fires.
  AND a.combo_state IS DISTINCT FROM 'pending'
  GROUP BY a.device_id, a.device_name, a.alarm_type, a.alarm_text, a.source_type
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
    -- COMBO MODE: when combo_enabled is true this group stops being a passive
    -- grouping and becomes an AND-combination trigger — its member alerts are
    -- held back individually and only surface as ONE merged alert once every
    -- member has fired for the same vehicle inside combo_window_seconds.
    combo_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    combo_window_seconds INTEGER NOT NULL DEFAULT 300,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Junction: which alert definitions belong to which group config.
  -- A definition may belong to MANY groups (combo or not).
  CREATE TABLE IF NOT EXISTS alert_group_config_members (
    id SERIAL PRIMARY KEY,
    group_config_id INTEGER NOT NULL REFERENCES alert_group_configs(id) ON DELETE CASCADE,
    alert_definition_id INTEGER NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_config_id, alert_definition_id)
  );

  -- Combo staging: one row per (combo, detection) held back until the combo
  -- completes. A detection can be staged in several combos at once, so this is
  -- a join table rather than a column on alerts. alerts.alert_group_id stays
  -- NULL while a row is pending — that is what keeps partials off the board.
  CREATE TABLE IF NOT EXISTS alert_combo_events (
    id SERIAL PRIMARY KEY,
    combo_group_config_id INTEGER NOT NULL REFERENCES alert_group_configs(id) ON DELETE CASCADE,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    alarm_type TEXT NOT NULL,
    alarm_ts TIMESTAMPTZ,
    state TEXT NOT NULL DEFAULT 'pending',
    alert_group_id INTEGER REFERENCES alert_groups(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(combo_group_config_id, alert_id)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_combo_events_pending
    ON alert_combo_events(combo_group_config_id, device_id, state, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_combo_events_alert
    ON alert_combo_events(alert_id);

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
  ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS mettax_device_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_alert_definitions_cc ON alert_definitions(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_alert_group_configs_cc ON alert_group_configs(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_driver_config_criteria_cc ON driver_config_criteria(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_rtms_rules_cc ON rtms_rules(cost_center_id);
  CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_cc ON fleet_vehicles(cost_center_id);

  -- Track cost center per driver scoring / fleet vehicle
  ALTER TABLE driver_scoring ADD COLUMN IF NOT EXISTS cost_center_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_driver_scoring_cc ON driver_scoring(cost_center_id);
  -- Alert Stats summary joins on UPPER(fleet_number)
  CREATE INDEX IF NOT EXISTS idx_driver_scoring_fleet_upper ON driver_scoring(UPPER(fleet_number));
  CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_fleet_upper ON fleet_vehicles(UPPER(fleet_number));
  -- One live group per device+type+source (open AND genuine). This is what
  -- makes "bump if live, else insert" airtight: the DB itself rejects a second
  -- live twin, so every creation path converges instead of racing. A resolved
  -- or false-alerted row is dead — the next event starts a fresh group.
  DROP INDEX IF EXISTS idx_ag_one_open;
  -- A previous deploy created this name with the resolved-only predicate;
  -- drop first so the false_alert-aware predicate below always applies.
  DROP INDEX IF EXISTS idx_ag_one_open_live;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ag_one_open_live
    ON alert_groups(device_id, alarm_type, source_type)
    WHERE (resolved = FALSE AND false_alert = FALSE);

  -- Authoritative fleet per group: EXACT registry values only, never parsed
  -- from names. All read paths join on this column (exact, case-insensitive)
  -- or on exact device ids — no ILIKE, no token splitting, no guessing.
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS fleet_number TEXT;
  CREATE INDEX IF NOT EXISTS idx_ag_fleet ON alert_groups(fleet_number);

  -- Alert watching presence: who has an alert open right now. Heartbeat rows
  -- go stale after 90s (swept lazily on read + every 5 min from the server).
  CREATE TABLE IF NOT EXISTS alert_watchers (
    alert_group_id INTEGER NOT NULL,
    user_email TEXT NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (alert_group_id, user_email)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_watchers_heartbeat ON alert_watchers(heartbeat_at);

  -- Vehicle alert overrides: alerts that must NOT be raised for a given
  -- vehicle. One row per vehicle; fleet_number and registration are
  -- independent match keys (an empty one is a wildcard).
  CREATE TABLE IF NOT EXISTS vehicle_alert_overrides (
    id SERIAL PRIMARY KEY,
    fleet_number TEXT,
    registration TEXT,
    alert_types TEXT[] NOT NULL DEFAULT '{}'::text[],
    signal_codes TEXT[] NOT NULL DEFAULT '{}'::text[],
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vae_vehicle
    ON vehicle_alert_overrides (COALESCE(fleet_number, ''), COALESCE(registration, ''));
  CREATE INDEX IF NOT EXISTS idx_vae_active ON vehicle_alert_overrides(is_active);

  CREATE TABLE IF NOT EXISTS camera_status (
    fleet_number TEXT PRIMARY KEY,
    reg TEXT,
    time_logged TIMESTAMPTZ DEFAULT NOW(),
    status TEXT,
    countdown INTERVAL,
    last_screenshot TIMESTAMPTZ,
    mettax_device_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_camera_status_fleet ON camera_status(fleet_number);
  CREATE INDEX IF NOT EXISTS idx_camera_status_time ON camera_status(time_logged DESC);

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
  -- History id-synthesis reads raw_data->>'id': expression index avoids heap
  -- scans on that lookup. raw_data uses LZ4 (PG14+) for faster detoast of the
  -- Toast payload on the list endpoints that still select it.
  CREATE INDEX IF NOT EXISTS idx_telematics_events_raw_id ON telematics_events((raw_data ->> 'id'));
  ALTER TABLE telematics_events ALTER COLUMN raw_data SET COMPRESSION lz4;

  -- Add source_type to alerts and alert_groups (video vs telematics)
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'video';
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'video';
  CREATE INDEX IF NOT EXISTS idx_alerts_source_type ON alerts(source_type);
  CREATE INDEX IF NOT EXISTS idx_alert_groups_source_type ON alert_groups(source_type);

  -- Follow-up: temporarily lower severity for 15 minutes
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS follow_up BOOLEAN DEFAULT FALSE;
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMPTZ;
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS original_severity TEXT;
  -- Severity resolved at emit time (CC override honored); read paths re-derive
  -- from alert_definitions/overrides, this column is a faithful stored snapshot.
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS severity TEXT;

  -- Member linkage: alert_groups is the live rollup, alerts holds every
  -- individual detection. Linked by PK (groups.id), never by text keys.
  -- Parity columns so a member row renders the detail modal identically.
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_group_id INTEGER REFERENCES alert_groups(id) ON DELETE SET NULL;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS speed DOUBLE PRECISION;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by TEXT;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS fleet_number TEXT;
  CREATE INDEX IF NOT EXISTS idx_alerts_group_id ON alerts(alert_group_id);

  -- Group-to-member resolve cascade: any group flip (resolve OR false
  -- alert, from ANY writer path) propagates to linked members in-DB, so no
  -- close path can leave members behind. BEFORE trigger so it can also zero
  -- the open-member count on the closing transition. Fires only on the
  -- open→closed edge — unrelated updates (notes, documents) never re-touch.
  CREATE OR REPLACE FUNCTION propagate_group_resolution() RETURNS trigger AS $$
  BEGIN
    IF (NEW.resolved OR NEW.false_alert) AND NOT (OLD.resolved OR OLD.false_alert) THEN
      NEW.count := 0;
      UPDATE alerts
      SET resolved = NEW.resolved,
          false_alert = NEW.false_alert,
          resolved_by = COALESCE(NEW.resolved_by, resolved_by),
          resolved_at = COALESCE(NEW.resolved_at, NOW()),
          updated_at = NOW()
      WHERE alert_group_id = NEW.id
        AND NOT resolved AND NOT false_alert;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_group_resolve ON alert_groups;
  CREATE TRIGGER trg_group_resolve
  BEFORE UPDATE OF resolved, false_alert ON alert_groups
  FOR EACH ROW WHEN (NEW.resolved OR NEW.false_alert)
  EXECUTE FUNCTION propagate_group_resolution();

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
  -- Speed episode dwell: timestamp when speed last dropped below threshold and we
  -- started re-arming; an alert fires once per sustained episode and only re-arms
  -- after the dwell window (see deviceStatusPoller).
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS speed_85_dwell_since TIMESTAMPTZ;
  ALTER TABLE vehicle_status ADD COLUMN IF NOT EXISTS speed_90_dwell_since TIMESTAMPTZ;
  -- Fast /vehicles/online: engine-on (is_driving=true) with fresh telematics time.
  CREATE INDEX IF NOT EXISTS idx_vehicle_status_driving_live
    ON vehicle_status (last_log_time DESC) WHERE is_driving = TRUE;

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
  -- Local edits made via the Stops UI: sync skips these rows on conflict so the
  -- 5-min Geotab sync cannot clobber user changes; is_deleted is a tombstone
  -- (a hard delete would be re-inserted by the next sync).
  ALTER TABLE geotab_zones ADD COLUMN IF NOT EXISTS locally_modified TIMESTAMPTZ;
  ALTER TABLE geotab_zones ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
  ALTER TABLE geotab_zones ADD COLUMN IF NOT EXISTS is_no_stopping BOOLEAN DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS idx_geotab_zones_deleted ON geotab_zones(is_deleted) WHERE is_deleted = TRUE;

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

  -- Telemetry history: every poller coordinate per vehicle. Written by the
  -- 15s DeviceStatusInfo poller only; rolling 12h window pruned hourly by the
  -- poller itself. event_time is the DEVICE event time, never storage time.
  CREATE TABLE IF NOT EXISTS telemetry_history (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    fleet_number TEXT,
    registration TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    event_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, event_time)
  );

  CREATE INDEX IF NOT EXISTS idx_telemetry_history_fleet_time ON telemetry_history(fleet_number, event_time);
  CREATE INDEX IF NOT EXISTS idx_telemetry_history_event_time ON telemetry_history(event_time);
  CREATE INDEX IF NOT EXISTS idx_telemetry_history_device_time ON telemetry_history(device_id, event_time);

  -- NCR escalation email outbox: the dashboard enqueues finished emails and
  -- returns instantly; the sweeper delivers in the background with retry, so
  -- a slow SMTP host never holds the NCR save dialog open.
  CREATE TABLE IF NOT EXISTS ncr_email_outbox (
    id SERIAL PRIMARY KEY,
    to_addrs TEXT[] NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    ncr_no TEXT,
    group_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_ncr_outbox_due ON ncr_email_outbox(status, next_retry_at) WHERE status IN ('pending', 'failed');

  -- Composite index for fast unresolved alert_groups lookup
  CREATE INDEX IF NOT EXISTS idx_alert_groups_resolved_ts ON alert_groups(resolved, last_alert_ts DESC) WHERE resolved = FALSE;

  -- Speed on alert_groups so telematics alerts (esp. Harsh Cornering etc.)
  -- show speed without an extra telematics_events lookup per open/modal.
  ALTER TABLE alert_groups ADD COLUMN IF NOT EXISTS speed DOUBLE PRECISION;

  -- Open-board list: WHERE resolved=FALSE AND false_alert=FALSE ORDER BY last_alert_ts DESC
  CREATE INDEX IF NOT EXISTS idx_ag_open_list ON alert_groups(resolved, false_alert, last_alert_ts DESC) WHERE resolved = FALSE AND false_alert = FALSE;
  -- Per-vehicle first paint: DISTINCT ON (device_id) ... ORDER BY device_id, last_alert_ts DESC
  CREATE INDEX IF NOT EXISTS idx_ag_per_vehicle ON alert_groups(device_id, last_alert_ts DESC) WHERE resolved = FALSE AND false_alert = FALSE;
  -- Cursor-paginated hydration: keyset on (last_alert_ts DESC, id DESC)
  CREATE INDEX IF NOT EXISTS idx_ag_open_cursor ON alert_groups(last_alert_ts DESC, id DESC) WHERE resolved = FALSE AND false_alert = FALSE;
  -- Delta polling: changed-since cursor over the open set
  CREATE INDEX IF NOT EXISTS idx_ag_open_updated ON alert_groups(updated_at) WHERE resolved = FALSE AND false_alert = FALSE;
  -- Delta tombstones: resolved-since cursor
  CREATE INDEX IF NOT EXISTS idx_ag_resolved_at ON alert_groups(resolved_at) WHERE resolved = TRUE;
  -- Detail/modal + media resolve by last alert id
  CREATE INDEX IF NOT EXISTS idx_ag_last_alert ON alert_groups(last_alert_id);
  -- Upsert hot path: device+type+source+resolved lookup
  CREATE INDEX IF NOT EXISTS idx_ag_upsert ON alert_groups(device_id, alarm_type, source_type, resolved);
  -- Telematics speed lookup by fleet + time window (getAlertById)
  CREATE INDEX IF NOT EXISTS idx_tev_fleet_time ON telematics_events(fleet_number, event_time DESC);
  -- Telematics device time-range scans (timeline, modal windows)
  CREATE INDEX IF NOT EXISTS idx_tev_device_time_desc ON telematics_events(device_id, event_time DESC);
  -- Geotab sibling expansion + ORDER BY fleet_number
  CREATE INDEX IF NOT EXISTS idx_vs_fleet ON vehicle_status(fleet_number);
  -- Zone entries per device+active+time
  CREATE INDEX IF NOT EXISTS idx_hre_active ON high_risk_zone_entries(device_id, is_active, entry_time DESC);
  -- Zone stop events per device+start
  CREATE INDEX IF NOT EXISTS idx_zse_device_start ON zone_stop_events(device_id, stop_start);

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

  -- ── NCR document store ──────────────────────────────────────────────
  -- ncr_forms holds the SIGNED NCR document exactly as it was submitted
  -- (every field, as displayed). The register renders from this instead of
  -- a PDF, so the record survives even if the PDF never got rendered.
  CREATE TABLE IF NOT EXISTS ncr_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID REFERENCES incidents(id) ON DELETE CASCADE,
    ncr_no TEXT,
    alert_id TEXT,
    alert_group_id INTEGER,
    alert_group_key TEXT,
    form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    document_path TEXT,
    document_status TEXT DEFAULT 'PENDING',
    status TEXT DEFAULT 'SAVED',
    error TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  -- The creator is the signed-in user, not a placeholder: the stable user id
  -- is kept for the audit tie and the email for display. New saves require it.
  ALTER TABLE ncr_forms ADD COLUMN IF NOT EXISTS created_by_id TEXT;
  ALTER TABLE ncr_forms ADD COLUMN IF NOT EXISTS created_by_email TEXT;
  -- The evidence archive (ZIP of every clip + screenshot of the group).
  ALTER TABLE ncr_forms ADD COLUMN IF NOT EXISTS archive_url TEXT;
  ALTER TABLE ncr_forms ADD COLUMN IF NOT EXISTS archive_status TEXT;
  ALTER TABLE ncr_forms ADD COLUMN IF NOT EXISTS archive_error TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ncr_forms_incident ON ncr_forms(incident_id);
  CREATE INDEX IF NOT EXISTS idx_ncr_forms_group ON ncr_forms(alert_group_id);
  CREATE INDEX IF NOT EXISTS idx_ncr_forms_ncr_no ON ncr_forms(ncr_no);
  CREATE INDEX IF NOT EXISTS idx_ncr_forms_status ON ncr_forms(status);
  CREATE INDEX IF NOT EXISTS idx_ncr_forms_creator ON ncr_forms(created_by_email);

  -- One evidence archive per alert group (the "apply all media" ZIP). The
  -- build downloads every clip + screenshot, zips them and uploads the ZIP;
  -- the NCR links it when it is ready.
  CREATE TABLE IF NOT EXISTS alert_group_archives (
    id SERIAL PRIMARY KEY,
    alert_group_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'BUILDING',
    url TEXT,
    error TEXT,
    file_count INTEGER DEFAULT 0,
    byte_size BIGINT DEFAULT 0,
    manifest JSONB DEFAULT '{}'::jsonb,
    requested_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_alert_group_archives_status ON alert_group_archives(status);

  -- Media attached to an NCR (the annexure), linked to the detection it came from.
  CREATE TABLE IF NOT EXISTS ncr_evidence (
    id SERIAL PRIMARY KEY,
    ncr_form_id UUID NOT NULL REFERENCES ncr_forms(id) ON DELETE CASCADE,
    alert_id TEXT,
    file_url TEXT NOT NULL,
    file_type TEXT,
    channel INTEGER,
    captured_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_ncr_evidence_form ON ncr_evidence(ncr_form_id);
  CREATE INDEX IF NOT EXISTS idx_ncr_evidence_alert ON ncr_evidence(alert_id);

  -- ── Generic background job queue ───────────────────────────────────
  -- Drives the parts of the NCR flow the user should never wait on:
  --   resolve  → close the alert group (+ members) for a saved NCR
  --   email    → hand the escalation email to the outbox
  --   footage  → request + store incident footage for collision alerts
  CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ncr_form_id UUID REFERENCES ncr_forms(id) ON DELETE CASCADE,
    incident_id UUID,
    alert_group_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(job_type, status);

  -- ── Incident footage (collision alerts) ─────────────────────────────
  -- Two links per collision alert, because they behave differently:
  --   replay_url -> the live history stream (.history.flv). Ready at once,
  --                 but one-shot: it can only be watched right away.
  --   file_url   -> the uploaded mp4 the camera produced for that exact
  --                 period. Durable: it can be played again later.
  -- video_url stays the resolved primary (file_url preferred, else
  -- replay_url) so every existing consumer keeps working.
  CREATE TABLE IF NOT EXISTS alert_footage (
    id SERIAL PRIMARY KEY,
    alert_id TEXT,
    alert_group_id INTEGER,
    device_id TEXT,
    fleet_number TEXT,
    registration TEXT,
    channel_id INTEGER,
    alarm_type TEXT,
    video_url TEXT,
    kind TEXT DEFAULT 'replay',
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    status TEXT DEFAULT 'REQUESTED',
    error TEXT,
    requested_by TEXT,
    replay_url TEXT,
    replay_state TEXT DEFAULT 'PENDING',
    replay_error TEXT,
    file_url TEXT,
    file_state TEXT DEFAULT 'PENDING',
    file_error TEXT,
    file_start TIMESTAMPTZ,
    file_end TIMESTAMPTZ,
    upload_task_id TEXT,
    upload_period_start TIMESTAMPTZ,
    upload_period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS replay_url TEXT;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS replay_state TEXT DEFAULT 'PENDING';
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS replay_error TEXT;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS file_url TEXT;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS file_state TEXT DEFAULT 'PENDING';
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS file_error TEXT;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS file_start TIMESTAMPTZ;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS file_end TIMESTAMPTZ;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS upload_task_id TEXT;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS upload_period_start TIMESTAMPTZ;
  ALTER TABLE alert_footage ADD COLUMN IF NOT EXISTS upload_period_end TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_alert_footage_group ON alert_footage(alert_group_id);
  CREATE INDEX IF NOT EXISTS idx_alert_footage_device ON alert_footage(device_id);
  CREATE INDEX IF NOT EXISTS idx_alert_footage_status ON alert_footage(status);
  CREATE INDEX IF NOT EXISTS idx_alert_footage_created_at ON alert_footage(created_at DESC);
  -- One row per alert + channel: the row is created by the replay and later
  -- upgraded in place when the uploaded file arrives.
  DELETE FROM alert_footage a USING alert_footage b
   WHERE a.id < b.id
     AND a.alert_id IS NOT DISTINCT FROM b.alert_id
     AND a.channel_id IS NOT DISTINCT FROM b.channel_id;
  DROP INDEX IF EXISTS idx_alert_footage_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_footage_unique
    ON alert_footage(alert_id, channel_id);

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
  -- Escalation Groups: contact people notified per cost center.
  -- Escalation group = a named set of contacts (emails) attached to
  -- one cost center (used for filtering/identity). Notifications are
  -- sent per category, each scoped to its own cost-center array:
  --   repair_cost_center_ids -> who receives repair notifications
  --   ncr_cost_center_ids    -> who receives NCR notifications
  -- An empty array means "global" = all cost centers.
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

  ALTER TABLE escalation_groups
    ADD COLUMN IF NOT EXISTS repair_cost_center_ids INTEGER[] NOT NULL DEFAULT '{}';
  ALTER TABLE escalation_groups
    ADD COLUMN IF NOT EXISTS ncr_cost_center_ids INTEGER[] NOT NULL DEFAULT '{}';

  CREATE TABLE IF NOT EXISTS escalation_group_members (
    id SERIAL PRIMARY KEY,
    escalation_group_id INTEGER NOT NULL REFERENCES escalation_groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_escalation_members_group ON escalation_group_members(escalation_group_id);

  -- Alert-definition linking was removed: notifications now flow through the
  -- Repair / NCR categories above. Drop the obsolete link table if present.
  DROP TABLE IF EXISTS escalation_group_alert_groups;

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

  -- ── COMBO MODE (AND-combination alert groups) ──
  -- combo_enabled defaults FALSE, so every existing group config stays a passive
  -- grouping and detection behaviour is unchanged until a group is explicitly
  -- turned into a combo.
  ALTER TABLE alert_group_configs ADD COLUMN IF NOT EXISTS combo_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE alert_group_configs ADD COLUMN IF NOT EXISTS combo_window_seconds INTEGER NOT NULL DEFAULT 300;

  -- alerts.combo_state marks a detection row that is being held back by a combo.
  -- 'pending' rows are filtered out of every list so a partial never surfaces;
  -- it is cleared to NULL the moment the detection is linked to a group, which
  -- makes it a normal row again.
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS combo_state TEXT;
  CREATE INDEX IF NOT EXISTS idx_alerts_combo_state ON alerts(combo_state) WHERE combo_state = 'pending';

  -- Staging join table (see SCHEMA_SQL for the full definition).
  CREATE TABLE IF NOT EXISTS alert_combo_events (
    id SERIAL PRIMARY KEY,
    combo_group_config_id INTEGER NOT NULL REFERENCES alert_group_configs(id) ON DELETE CASCADE,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    alarm_type TEXT NOT NULL,
    alarm_ts TIMESTAMPTZ,
    state TEXT NOT NULL DEFAULT 'pending',
    alert_group_id INTEGER REFERENCES alert_groups(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(combo_group_config_id, alert_id)
  );
  CREATE INDEX IF NOT EXISTS idx_alert_combo_events_pending
    ON alert_combo_events(combo_group_config_id, device_id, state, alarm_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_alert_combo_events_alert
    ON alert_combo_events(alert_id);

  -- One detection must not satisfy two combos at once: when a combo fires, any
  -- other pending staging row for the same alert is retired.
  CREATE INDEX IF NOT EXISTS idx_alert_combo_events_by_alert_pending
    ON alert_combo_events(alert_id) WHERE state = 'pending';
`;

async function initializeDatabase() {
  await query(SCHEMA_SQL);
  console.log('[DB] Schema initialized successfully');
  await query(MIGRATIONS_SQL);
  console.log('[DB] Migrations applied successfully');
}

module.exports = { initializeDatabase };
