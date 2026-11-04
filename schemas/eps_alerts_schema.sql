--
-- PostgreSQL database dump
--

\restrict J9Wr5j03qnq9YisElCeIpLfX8Me7pWUVxjsXiH59L0zxUeAhex6MRdIoHhmDqiN

-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alert_definition_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_definition_overrides (
    id integer NOT NULL,
    alert_definition_id integer NOT NULL,
    cost_center_id integer NOT NULL,
    severity text,
    description text,
    is_active boolean,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: alert_definition_overrides_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_definition_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_definition_overrides_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_definition_overrides_id_seq OWNED BY public.alert_definition_overrides.id;


--
-- Name: alert_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_definitions (
    id integer NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    description text DEFAULT ''::text,
    signal_code text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    severity text DEFAULT 'MEDIUM'::text NOT NULL,
    CONSTRAINT alert_definitions_category_check CHECK ((category = ANY (ARRAY['telematics'::text, 'video'::text])))
);


--
-- Name: alert_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_definitions_id_seq OWNED BY public.alert_definitions.id;


--
-- Name: alert_group_config_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_group_config_members (
    id integer NOT NULL,
    group_config_id integer NOT NULL,
    alert_definition_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: alert_group_config_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_group_config_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_group_config_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_group_config_members_id_seq OWNED BY public.alert_group_config_members.id;


--
-- Name: alert_group_config_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_group_config_overrides (
    id integer NOT NULL,
    group_config_id integer NOT NULL,
    cost_center_id integer NOT NULL,
    severity text,
    description text,
    is_active boolean,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: alert_group_config_overrides_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_group_config_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_group_config_overrides_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_group_config_overrides_id_seq OWNED BY public.alert_group_config_overrides.id;


--
-- Name: alert_group_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_group_configs (
    id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    severity text DEFAULT 'MEDIUM'::text NOT NULL
);


--
-- Name: alert_group_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_group_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_group_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_group_configs_id_seq OWNED BY public.alert_group_configs.id;


--
-- Name: alert_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_groups (
    id integer NOT NULL,
    group_key text NOT NULL,
    device_id text NOT NULL,
    device_name text,
    alarm_type text NOT NULL,
    alarm_text text,
    count integer DEFAULT 1,
    last_alert_id text NOT NULL,
    last_alert_ts timestamp with time zone,
    lat double precision,
    lon double precision,
    status text DEFAULT 'new'::text,
    resolved boolean DEFAULT false,
    false_alert boolean DEFAULT false,
    resolved_at timestamp with time zone,
    resolved_by text,
    notes text,
    documents jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source_type text DEFAULT 'video'::text,
    follow_up boolean DEFAULT false,
    follow_up_at timestamp with time zone,
    original_severity text
);


--
-- Name: alert_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_groups_id_seq OWNED BY public.alert_groups.id;


--
-- Name: alert_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_media (
    id integer NOT NULL,
    alert_id text NOT NULL,
    file_url text NOT NULL,
    file_type text,
    file_size double precision,
    device_name text,
    alarm_type text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: alert_media_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alert_media_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_media_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_media_id_seq OWNED BY public.alert_media.id;


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id text NOT NULL,
    device_id text NOT NULL,
    device_name text,
    alarm_type text NOT NULL,
    alarm_ts timestamp with time zone,
    alarm_ts_end timestamp with time zone,
    lat double precision,
    lon double precision,
    alarm_text text,
    serial_no text,
    fence_id text,
    alarm_extension text,
    status text DEFAULT 'new'::text,
    resolved boolean DEFAULT false,
    false_alert boolean DEFAULT false,
    notes text,
    documents jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source_type text DEFAULT 'video'::text
);


--
-- Name: config_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_group_members (
    group_id integer NOT NULL,
    cost_center_id integer NOT NULL
);


--
-- Name: config_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_groups (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: config_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.config_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: config_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.config_groups_id_seq OWNED BY public.config_groups.id;


--
-- Name: cost_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_centers (
    id integer NOT NULL,
    name text NOT NULL,
    code text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: driver_config_criteria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_config_criteria (
    id integer NOT NULL,
    name text NOT NULL,
    selected_weighting numeric DEFAULT 10,
    actual_weighting numeric DEFAULT 10,
    risk_tiers integer DEFAULT 4,
    no_incidents integer DEFAULT 0,
    statuses text[] DEFAULT '{}'::text[],
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    nrc_deduction boolean DEFAULT false,
    incidents_threshold integer DEFAULT 1,
    deduction_per_alert numeric DEFAULT 10,
    deduction_with_ncr numeric DEFAULT 0,
    ncr_threshold integer DEFAULT 3,
    cost_center_id integer,
    config_group_id integer
);


--
-- Name: driver_config_criteria_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.driver_config_criteria_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_config_criteria_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.driver_config_criteria_id_seq OWNED BY public.driver_config_criteria.id;


--
-- Name: driver_scoring; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_scoring (
    id integer NOT NULL,
    registration_number text,
    fleet_number text NOT NULL,
    driver text,
    score numeric DEFAULT 100,
    alert_types jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cost_center_id integer,
    CONSTRAINT driver_scoring_score_check CHECK ((score >= (0)::numeric))
);


--
-- Name: driver_scoring_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.driver_scoring_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_scoring_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.driver_scoring_id_seq OWNED BY public.driver_scoring.id;


--
-- Name: escalation_group_alert_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escalation_group_alert_groups (
    escalation_group_id integer NOT NULL,
    alert_definition_id integer NOT NULL
);


--
-- Name: escalation_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escalation_group_members (
    id integer NOT NULL,
    escalation_group_id integer NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: escalation_group_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.escalation_group_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: escalation_group_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.escalation_group_members_id_seq OWNED BY public.escalation_group_members.id;


--
-- Name: escalation_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escalation_groups (
    id integer NOT NULL,
    name text NOT NULL,
    cost_center_id integer,
    description text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: escalation_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.escalation_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: escalation_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.escalation_groups_id_seq OWNED BY public.escalation_groups.id;


--
-- Name: fleet_vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleet_vehicles (
    fleet_number text,
    registration_number text,
    make text,
    model text,
    cost_center text,
    last_synced timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cost_center_id integer
);


--
-- Name: fleet_vehicles_bak_preclean; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleet_vehicles_bak_preclean (
    fleet_number text,
    registration_number text,
    make text,
    model text,
    cost_center text,
    last_synced timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    cost_center_id integer
);


--
-- Name: geotab_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geotab_devices (
    id text NOT NULL,
    name text,
    fleet_number text,
    license_plate text,
    device_type text,
    vin text,
    serial_number text,
    fuel_tank_capacity double precision,
    timezone text,
    is_active boolean DEFAULT true,
    active_from timestamp with time zone,
    active_to timestamp with time zone,
    groups jsonb DEFAULT '[]'::jsonb,
    raw_data jsonb DEFAULT '{}'::jsonb,
    last_synced timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: geotab_diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geotab_diagnostics (
    id text NOT NULL,
    name text,
    unit text,
    raw_data jsonb DEFAULT '{}'::jsonb,
    last_synced timestamp with time zone DEFAULT now()
);


--
-- Name: geotab_exception_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geotab_exception_rules (
    id text NOT NULL,
    name text,
    description text,
    raw_data jsonb DEFAULT '{}'::jsonb,
    last_synced timestamp with time zone DEFAULT now()
);


--
-- Name: geotab_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geotab_groups (
    id text NOT NULL,
    name text,
    parent_id text,
    is_global boolean DEFAULT false,
    raw_data jsonb DEFAULT '{}'::jsonb,
    last_synced timestamp with time zone DEFAULT now()
);


--
-- Name: geotab_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geotab_zones (
    id text NOT NULL,
    name text,
    points jsonb DEFAULT '[]'::jsonb,
    zone_types jsonb DEFAULT '[]'::jsonb,
    comment text,
    is_high_risk boolean DEFAULT false,
    is_no_go boolean DEFAULT false,
    raw_data jsonb DEFAULT '{}'::jsonb,
    last_synced timestamp with time zone DEFAULT now()
);


--
-- Name: high_risk_zone_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.high_risk_zone_entries (
    id integer NOT NULL,
    device_id text NOT NULL,
    fleet_number text,
    license_plate text,
    zone_id text NOT NULL,
    zone_name text NOT NULL,
    risk_level text NOT NULL,
    latitude double precision,
    longitude double precision,
    speed double precision,
    entry_time timestamp with time zone NOT NULL,
    exit_time timestamp with time zone,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: high_risk_zone_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.high_risk_zone_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: high_risk_zone_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.high_risk_zone_entries_id_seq OWNED BY public.high_risk_zone_entries.id;


--
-- Name: incident_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.incident_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incidents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    incident_no text DEFAULT ((('INC-'::text || to_char(now(), 'YYYY'::text)) || '-'::text) || lpad((nextval('public.incident_no_seq'::regclass))::text, 4, '0'::text)),
    alert_id text,
    alert_group_key text,
    alarm_type text,
    source_type text DEFAULT 'telematics'::text,
    device_id text,
    fleet_number text,
    cost_center_id integer,
    week integer,
    shift text,
    incident_date date,
    incident_time time without time zone,
    controller text,
    driver_name text,
    contact_number text,
    id_number text,
    division text,
    infringement text,
    infringement_detail text,
    action_taken text,
    outcome text,
    notes text,
    document_link text,
    document_type text,
    status text DEFAULT 'OPEN'::text,
    filled_by text,
    filled_at timestamp with time zone DEFAULT now(),
    resolved_by text,
    resolved_at timestamp with time zone,
    closure_type text,
    deduction_applied numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: repair_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repair_requests (
    id integer NOT NULL,
    alert_id text,
    fleet_number text,
    registration text,
    device_id text,
    cost_center_id integer,
    status text DEFAULT 'pending'::text,
    notes text,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    contact_name text,
    contact_phone text,
    contact_email text,
    available_at timestamp with time zone,
    issue_description text,
    job_description text,
    priority text DEFAULT 'medium'::text,
    account_code text DEFAULT 'SRS-0001'::text,
    external_job_number text,
    external_job_type text,
    external_status text DEFAULT 'pending'::text,
    external_response jsonb DEFAULT '{}'::jsonb
);


--
-- Name: repair_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.repair_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: repair_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.repair_requests_id_seq OWNED BY public.repair_requests.id;


--
-- Name: rtms_driving_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rtms_driving_sessions (
    id integer NOT NULL,
    device_id text NOT NULL,
    fleet_number text,
    registration_number text,
    engine_on_at timestamp with time zone NOT NULL,
    engine_off_at timestamp with time zone,
    duration_minutes numeric GENERATED ALWAYS AS (
CASE
    WHEN (engine_off_at IS NOT NULL) THEN (EXTRACT(epoch FROM (engine_off_at - engine_on_at)) / (60)::numeric)
    ELSE NULL::numeric
END) STORED,
    alert_sent boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    cost_center_id integer
);


--
-- Name: rtms_driving_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rtms_driving_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rtms_driving_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rtms_driving_sessions_id_seq OWNED BY public.rtms_driving_sessions.id;


--
-- Name: rtms_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rtms_rules (
    id integer NOT NULL,
    module text NOT NULL,
    rule_name text NOT NULL,
    system_constraint text DEFAULT ''::text,
    audit_focus text DEFAULT ''::text,
    max_value numeric DEFAULT 0,
    min_value numeric DEFAULT 0,
    unit text DEFAULT ''::text,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cost_center_id integer
);


--
-- Name: rtms_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rtms_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rtms_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rtms_rules_id_seq OWNED BY public.rtms_rules.id;


--
-- Name: telematics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telematics_events (
    id integer NOT NULL,
    device_id text NOT NULL,
    vehicle_id text,
    plate text,
    event_type text NOT NULL,
    event_code text,
    severity text DEFAULT 'LOW'::text,
    latitude double precision,
    longitude double precision,
    speed double precision,
    address text,
    driver_name text,
    description text,
    raw_data jsonb DEFAULT '{}'::jsonb,
    event_time timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    license_plate text,
    fleet_number text,
    distance double precision,
    duration_seconds integer,
    zone_name text
);


--
-- Name: telematics_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.telematics_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telematics_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.telematics_events_id_seq OWNED BY public.telematics_events.id;


--
-- Name: vehicle_log_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_log_records (
    id integer NOT NULL,
    device_id text NOT NULL,
    latitude double precision,
    longitude double precision,
    speed double precision,
    heading double precision,
    odometer double precision,
    record_time timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: vehicle_log_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_log_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_log_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_log_records_id_seq OWNED BY public.vehicle_log_records.id;


--
-- Name: vehicle_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_status (
    device_id text NOT NULL,
    plate text,
    license_plate text,
    fleet_number text,
    engine_on boolean,
    ignition_on boolean,
    speed double precision,
    latitude double precision,
    longitude double precision,
    last_log_time timestamp with time zone,
    last_update timestamp with time zone DEFAULT now()
);


--
-- Name: alert_definition_overrides id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definition_overrides ALTER COLUMN id SET DEFAULT nextval('public.alert_definition_overrides_id_seq'::regclass);


--
-- Name: alert_definitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definitions ALTER COLUMN id SET DEFAULT nextval('public.alert_definitions_id_seq'::regclass);


--
-- Name: alert_group_config_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_members ALTER COLUMN id SET DEFAULT nextval('public.alert_group_config_members_id_seq'::regclass);


--
-- Name: alert_group_config_overrides id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_overrides ALTER COLUMN id SET DEFAULT nextval('public.alert_group_config_overrides_id_seq'::regclass);


--
-- Name: alert_group_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_configs ALTER COLUMN id SET DEFAULT nextval('public.alert_group_configs_id_seq'::regclass);


--
-- Name: alert_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_groups ALTER COLUMN id SET DEFAULT nextval('public.alert_groups_id_seq'::regclass);


--
-- Name: alert_media id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_media ALTER COLUMN id SET DEFAULT nextval('public.alert_media_id_seq'::regclass);


--
-- Name: config_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_groups ALTER COLUMN id SET DEFAULT nextval('public.config_groups_id_seq'::regclass);


--
-- Name: driver_config_criteria id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_config_criteria ALTER COLUMN id SET DEFAULT nextval('public.driver_config_criteria_id_seq'::regclass);


--
-- Name: driver_scoring id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_scoring ALTER COLUMN id SET DEFAULT nextval('public.driver_scoring_id_seq'::regclass);


--
-- Name: escalation_group_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_group_members ALTER COLUMN id SET DEFAULT nextval('public.escalation_group_members_id_seq'::regclass);


--
-- Name: escalation_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_groups ALTER COLUMN id SET DEFAULT nextval('public.escalation_groups_id_seq'::regclass);


--
-- Name: high_risk_zone_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.high_risk_zone_entries ALTER COLUMN id SET DEFAULT nextval('public.high_risk_zone_entries_id_seq'::regclass);


--
-- Name: repair_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repair_requests ALTER COLUMN id SET DEFAULT nextval('public.repair_requests_id_seq'::regclass);


--
-- Name: rtms_driving_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rtms_driving_sessions ALTER COLUMN id SET DEFAULT nextval('public.rtms_driving_sessions_id_seq'::regclass);


--
-- Name: rtms_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rtms_rules ALTER COLUMN id SET DEFAULT nextval('public.rtms_rules_id_seq'::regclass);


--
-- Name: telematics_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telematics_events ALTER COLUMN id SET DEFAULT nextval('public.telematics_events_id_seq'::regclass);


--
-- Name: vehicle_log_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_log_records ALTER COLUMN id SET DEFAULT nextval('public.vehicle_log_records_id_seq'::regclass);


--
-- Name: alert_definition_overrides alert_definition_overrides_alert_definition_id_cost_center__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definition_overrides
    ADD CONSTRAINT alert_definition_overrides_alert_definition_id_cost_center__key UNIQUE (alert_definition_id, cost_center_id);


--
-- Name: alert_definition_overrides alert_definition_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definition_overrides
    ADD CONSTRAINT alert_definition_overrides_pkey PRIMARY KEY (id);


--
-- Name: alert_definitions alert_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definitions
    ADD CONSTRAINT alert_definitions_pkey PRIMARY KEY (id);


--
-- Name: alert_definitions alert_definitions_signal_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definitions
    ADD CONSTRAINT alert_definitions_signal_code_unique UNIQUE (signal_code);


--
-- Name: alert_group_config_members alert_group_config_members_group_config_id_alert_definition_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_members
    ADD CONSTRAINT alert_group_config_members_group_config_id_alert_definition_key UNIQUE (group_config_id, alert_definition_id);


--
-- Name: alert_group_config_members alert_group_config_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_members
    ADD CONSTRAINT alert_group_config_members_pkey PRIMARY KEY (id);


--
-- Name: alert_group_config_overrides alert_group_config_overrides_group_config_id_cost_center_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_overrides
    ADD CONSTRAINT alert_group_config_overrides_group_config_id_cost_center_id_key UNIQUE (group_config_id, cost_center_id);


--
-- Name: alert_group_config_overrides alert_group_config_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_overrides
    ADD CONSTRAINT alert_group_config_overrides_pkey PRIMARY KEY (id);


--
-- Name: alert_group_configs alert_group_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_configs
    ADD CONSTRAINT alert_group_configs_pkey PRIMARY KEY (id);


--
-- Name: alert_groups alert_groups_group_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_groups
    ADD CONSTRAINT alert_groups_group_key_key UNIQUE (group_key);


--
-- Name: alert_groups alert_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_groups
    ADD CONSTRAINT alert_groups_pkey PRIMARY KEY (id);


--
-- Name: alert_media alert_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_media
    ADD CONSTRAINT alert_media_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: config_group_members config_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_group_members
    ADD CONSTRAINT config_group_members_pkey PRIMARY KEY (group_id, cost_center_id);


--
-- Name: config_groups config_groups_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_groups
    ADD CONSTRAINT config_groups_name_key UNIQUE (name);


--
-- Name: config_groups config_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_groups
    ADD CONSTRAINT config_groups_pkey PRIMARY KEY (id);


--
-- Name: cost_centers cost_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centers
    ADD CONSTRAINT cost_centers_pkey PRIMARY KEY (id);


--
-- Name: driver_config_criteria driver_config_criteria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_config_criteria
    ADD CONSTRAINT driver_config_criteria_pkey PRIMARY KEY (id);


--
-- Name: driver_config_criteria driver_config_criteria_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_config_criteria
    ADD CONSTRAINT driver_config_criteria_scope_unique UNIQUE (name, config_group_id, cost_center_id);


--
-- Name: driver_scoring driver_scoring_fleet_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_scoring
    ADD CONSTRAINT driver_scoring_fleet_number_key UNIQUE (fleet_number);


--
-- Name: driver_scoring driver_scoring_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_scoring
    ADD CONSTRAINT driver_scoring_pkey PRIMARY KEY (id);


--
-- Name: escalation_group_alert_groups escalation_group_alert_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_group_alert_groups
    ADD CONSTRAINT escalation_group_alert_groups_pkey PRIMARY KEY (escalation_group_id, alert_definition_id);


--
-- Name: escalation_group_members escalation_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_group_members
    ADD CONSTRAINT escalation_group_members_pkey PRIMARY KEY (id);


--
-- Name: escalation_groups escalation_groups_name_cost_center_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_groups
    ADD CONSTRAINT escalation_groups_name_cost_center_id_key UNIQUE (name, cost_center_id);


--
-- Name: escalation_groups escalation_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_groups
    ADD CONSTRAINT escalation_groups_pkey PRIMARY KEY (id);


--
-- Name: fleet_vehicles fleet_vehicles_fleet_number_registration_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_vehicles
    ADD CONSTRAINT fleet_vehicles_fleet_number_registration_number_key UNIQUE (fleet_number, registration_number);


--
-- Name: geotab_devices geotab_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geotab_devices
    ADD CONSTRAINT geotab_devices_pkey PRIMARY KEY (id);


--
-- Name: geotab_diagnostics geotab_diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geotab_diagnostics
    ADD CONSTRAINT geotab_diagnostics_pkey PRIMARY KEY (id);


--
-- Name: geotab_exception_rules geotab_exception_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geotab_exception_rules
    ADD CONSTRAINT geotab_exception_rules_pkey PRIMARY KEY (id);


--
-- Name: geotab_groups geotab_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geotab_groups
    ADD CONSTRAINT geotab_groups_pkey PRIMARY KEY (id);


--
-- Name: geotab_zones geotab_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geotab_zones
    ADD CONSTRAINT geotab_zones_pkey PRIMARY KEY (id);


--
-- Name: high_risk_zone_entries high_risk_zone_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.high_risk_zone_entries
    ADD CONSTRAINT high_risk_zone_entries_pkey PRIMARY KEY (id);


--
-- Name: incidents incidents_alert_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_alert_id_key UNIQUE (alert_id);


--
-- Name: incidents incidents_incident_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_incident_no_key UNIQUE (incident_no);


--
-- Name: incidents incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);


--
-- Name: repair_requests repair_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repair_requests
    ADD CONSTRAINT repair_requests_pkey PRIMARY KEY (id);


--
-- Name: rtms_driving_sessions rtms_driving_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rtms_driving_sessions
    ADD CONSTRAINT rtms_driving_sessions_pkey PRIMARY KEY (id);


--
-- Name: rtms_rules rtms_rules_cc_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rtms_rules
    ADD CONSTRAINT rtms_rules_cc_unique UNIQUE (rule_name, cost_center_id);


--
-- Name: rtms_rules rtms_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rtms_rules
    ADD CONSTRAINT rtms_rules_pkey PRIMARY KEY (id);


--
-- Name: rtms_rules rtms_rules_rule_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rtms_rules
    ADD CONSTRAINT rtms_rules_rule_name_unique UNIQUE (rule_name);


--
-- Name: telematics_events telematics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telematics_events
    ADD CONSTRAINT telematics_events_pkey PRIMARY KEY (id);


--
-- Name: vehicle_log_records vehicle_log_records_device_id_record_time_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_log_records
    ADD CONSTRAINT vehicle_log_records_device_id_record_time_key UNIQUE (device_id, record_time);


--
-- Name: vehicle_log_records vehicle_log_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_log_records
    ADD CONSTRAINT vehicle_log_records_pkey PRIMARY KEY (id);


--
-- Name: vehicle_status vehicle_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_status
    ADD CONSTRAINT vehicle_status_pkey PRIMARY KEY (device_id);


--
-- Name: idx_alert_def_overrides_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_def_overrides_cc ON public.alert_definition_overrides USING btree (cost_center_id);


--
-- Name: idx_alert_def_overrides_def; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_def_overrides_def ON public.alert_definition_overrides USING btree (alert_definition_id);


--
-- Name: idx_alert_definitions_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_definitions_category ON public.alert_definitions USING btree (category);


--
-- Name: idx_alert_group_config_members_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_group_config_members_group ON public.alert_group_config_members USING btree (group_config_id);


--
-- Name: idx_alert_group_configs_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_group_configs_severity ON public.alert_group_configs USING btree (severity);


--
-- Name: idx_alert_groups_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_device ON public.alert_groups USING btree (device_id);


--
-- Name: idx_alert_groups_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_key ON public.alert_groups USING btree (group_key);


--
-- Name: idx_alert_groups_last_alert_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_last_alert_id ON public.alert_groups USING btree (last_alert_id);


--
-- Name: idx_alert_groups_resolved_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_resolved_ts ON public.alert_groups USING btree (resolved, last_alert_ts DESC);


--
-- Name: idx_alert_groups_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_source_type ON public.alert_groups USING btree (source_type);


--
-- Name: idx_alert_groups_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_ts ON public.alert_groups USING btree (last_alert_ts DESC);


--
-- Name: idx_alert_groups_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_groups_type ON public.alert_groups USING btree (alarm_type);


--
-- Name: idx_alert_grp_overrides_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_grp_overrides_cc ON public.alert_group_config_overrides USING btree (cost_center_id);


--
-- Name: idx_alert_grp_overrides_grp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_grp_overrides_grp ON public.alert_group_config_overrides USING btree (group_config_id);


--
-- Name: idx_alert_media_alert_file; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_media_alert_file ON public.alert_media USING btree (alert_id, file_url);


--
-- Name: idx_alert_media_alert_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_media_alert_id ON public.alert_media USING btree (alert_id);


--
-- Name: idx_alerts_alarm_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_alarm_ts ON public.alerts USING btree (alarm_ts DESC);


--
-- Name: idx_alerts_alarm_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_alarm_type ON public.alerts USING btree (alarm_type);


--
-- Name: idx_alerts_device_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_device_id ON public.alerts USING btree (device_id);


--
-- Name: idx_alerts_device_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_device_ts ON public.alerts USING btree (device_id, alarm_ts DESC);


--
-- Name: idx_alerts_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_source_type ON public.alerts USING btree (source_type);


--
-- Name: idx_alerts_type_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_type_ts ON public.alerts USING btree (alarm_type, alarm_ts DESC);


--
-- Name: idx_alerts_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_unresolved ON public.alerts USING btree (device_id, alarm_ts DESC) WHERE ((resolved = false) AND (false_alert = false));


--
-- Name: idx_alerts_unresolved_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_unresolved_name ON public.alerts USING btree (device_name, alarm_ts DESC) WHERE ((resolved = false) AND (false_alert = false));


--
-- Name: idx_config_group_members_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_config_group_members_cc ON public.config_group_members USING btree (cost_center_id);


--
-- Name: idx_cost_centers_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cost_centers_code ON public.cost_centers USING btree (code);


--
-- Name: idx_cost_centers_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cost_centers_name ON public.cost_centers USING btree (name);


--
-- Name: idx_driver_config_criteria_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_config_criteria_cc ON public.driver_config_criteria USING btree (cost_center_id);


--
-- Name: idx_driver_config_criteria_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_config_criteria_group ON public.driver_config_criteria USING btree (config_group_id);


--
-- Name: idx_driver_config_criteria_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_config_criteria_name ON public.driver_config_criteria USING btree (name);


--
-- Name: idx_driver_config_criteria_nrc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_config_criteria_nrc ON public.driver_config_criteria USING btree (nrc_deduction);


--
-- Name: idx_driver_scoring_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_scoring_cc ON public.driver_scoring USING btree (cost_center_id);


--
-- Name: idx_driver_scoring_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_scoring_fleet ON public.driver_scoring USING btree (fleet_number);


--
-- Name: idx_driver_scoring_registration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_scoring_registration ON public.driver_scoring USING btree (registration_number);


--
-- Name: idx_escalation_alertgroups_grp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalation_alertgroups_grp ON public.escalation_group_alert_groups USING btree (escalation_group_id);


--
-- Name: idx_escalation_groups_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalation_groups_cc ON public.escalation_groups USING btree (cost_center_id);


--
-- Name: idx_escalation_members_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalation_members_group ON public.escalation_group_members USING btree (escalation_group_id);


--
-- Name: idx_fleet_vehicles_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_vehicles_cc ON public.fleet_vehicles USING btree (cost_center_id);


--
-- Name: idx_fleet_vehicles_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_vehicles_fleet ON public.fleet_vehicles USING btree (fleet_number);


--
-- Name: idx_fleet_vehicles_unq_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fleet_vehicles_unq_fleet ON public.fleet_vehicles USING btree (lower(replace(TRIM(BOTH FROM fleet_number), ' '::text, ''::text)));


--
-- Name: idx_fleet_vehicles_unq_reg; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fleet_vehicles_unq_reg ON public.fleet_vehicles USING btree (lower(replace(TRIM(BOTH FROM registration_number), ' '::text, ''::text)));


--
-- Name: idx_geotab_devices_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geotab_devices_fleet ON public.geotab_devices USING btree (fleet_number);


--
-- Name: idx_geotab_devices_plate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geotab_devices_plate ON public.geotab_devices USING btree (license_plate);


--
-- Name: idx_high_risk_zone_entries_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_high_risk_zone_entries_active ON public.high_risk_zone_entries USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_high_risk_zone_entries_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_high_risk_zone_entries_device ON public.high_risk_zone_entries USING btree (device_id);


--
-- Name: idx_high_risk_zone_entries_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_high_risk_zone_entries_time ON public.high_risk_zone_entries USING btree (entry_time DESC);


--
-- Name: idx_incidents_cc_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_cc_date ON public.incidents USING btree (cost_center_id, incident_date DESC);


--
-- Name: idx_incidents_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_fleet ON public.incidents USING btree (fleet_number);


--
-- Name: idx_incidents_status_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_status_date ON public.incidents USING btree (status, incident_date DESC);


--
-- Name: idx_repair_requests_ext_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repair_requests_ext_job ON public.repair_requests USING btree (external_job_number);


--
-- Name: idx_repair_requests_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repair_requests_fleet ON public.repair_requests USING btree (fleet_number);


--
-- Name: idx_repair_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repair_requests_status ON public.repair_requests USING btree (status);


--
-- Name: idx_rtms_rules_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rtms_rules_cc ON public.rtms_rules USING btree (cost_center_id);


--
-- Name: idx_rtms_rules_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rtms_rules_module ON public.rtms_rules USING btree (module);


--
-- Name: idx_rtms_sessions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rtms_sessions_active ON public.rtms_driving_sessions USING btree (engine_off_at) WHERE (engine_off_at IS NULL);


--
-- Name: idx_rtms_sessions_cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rtms_sessions_cc ON public.rtms_driving_sessions USING btree (cost_center_id);


--
-- Name: idx_rtms_sessions_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rtms_sessions_device ON public.rtms_driving_sessions USING btree (device_id);


--
-- Name: idx_telematics_events_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telematics_events_device ON public.telematics_events USING btree (device_id);


--
-- Name: idx_telematics_events_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telematics_events_device_time ON public.telematics_events USING btree (device_id, event_time);


--
-- Name: idx_telematics_events_plate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telematics_events_plate ON public.telematics_events USING btree (plate);


--
-- Name: idx_telematics_events_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telematics_events_time ON public.telematics_events USING btree (event_time DESC);


--
-- Name: idx_telematics_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telematics_events_type ON public.telematics_events USING btree (event_type);


--
-- Name: idx_vehicle_log_records_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_log_records_device_time ON public.vehicle_log_records USING btree (device_id, record_time);


--
-- Name: alert_definition_overrides alert_definition_overrides_alert_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_definition_overrides
    ADD CONSTRAINT alert_definition_overrides_alert_definition_id_fkey FOREIGN KEY (alert_definition_id) REFERENCES public.alert_definitions(id) ON DELETE CASCADE;


--
-- Name: alert_group_config_members alert_group_config_members_alert_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_members
    ADD CONSTRAINT alert_group_config_members_alert_definition_id_fkey FOREIGN KEY (alert_definition_id) REFERENCES public.alert_definitions(id) ON DELETE CASCADE;


--
-- Name: alert_group_config_members alert_group_config_members_group_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_members
    ADD CONSTRAINT alert_group_config_members_group_config_id_fkey FOREIGN KEY (group_config_id) REFERENCES public.alert_group_configs(id) ON DELETE CASCADE;


--
-- Name: alert_group_config_overrides alert_group_config_overrides_group_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_group_config_overrides
    ADD CONSTRAINT alert_group_config_overrides_group_config_id_fkey FOREIGN KEY (group_config_id) REFERENCES public.alert_group_configs(id) ON DELETE CASCADE;


--
-- Name: alert_media alert_media_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_media
    ADD CONSTRAINT alert_media_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alerts(id) ON DELETE CASCADE;


--
-- Name: config_group_members config_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_group_members
    ADD CONSTRAINT config_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.config_groups(id) ON DELETE CASCADE;


--
-- Name: escalation_group_alert_groups escalation_group_alert_groups_alert_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_group_alert_groups
    ADD CONSTRAINT escalation_group_alert_groups_alert_definition_id_fkey FOREIGN KEY (alert_definition_id) REFERENCES public.alert_definitions(id) ON DELETE CASCADE;


--
-- Name: escalation_group_alert_groups escalation_group_alert_groups_escalation_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_group_alert_groups
    ADD CONSTRAINT escalation_group_alert_groups_escalation_group_id_fkey FOREIGN KEY (escalation_group_id) REFERENCES public.escalation_groups(id) ON DELETE CASCADE;


--
-- Name: escalation_group_members escalation_group_members_escalation_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_group_members
    ADD CONSTRAINT escalation_group_members_escalation_group_id_fkey FOREIGN KEY (escalation_group_id) REFERENCES public.escalation_groups(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict J9Wr5j03qnq9YisElCeIpLfX8Me7pWUVxjsXiH59L0zxUeAhex6MRdIoHhmDqiN

