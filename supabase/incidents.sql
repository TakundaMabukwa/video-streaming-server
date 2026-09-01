-- NCR / Incident Register (Reports) — Supabase SQL handout
-- Run this in the Supabase SQL editor. The backend Postgres (droplet) is the source of truth;
-- this mirror exists so the ops editor can browse/query the same register.

-- Sequence for INC-YYYY-NNNN numbering (backend uses its own; this one only serves the mirror)
CREATE SEQUENCE IF NOT EXISTS incident_no_seq;

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_no TEXT UNIQUE DEFAULT ('INC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('incident_no_seq')::bigint::text, 4, '0')),
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
CREATE INDEX IF NOT EXISTS idx_incidents_alert_id ON incidents(alert_id);

-- Register view matching the Reports editor columns
CREATE OR REPLACE VIEW v_incidents_register AS
SELECT
  incident_no                AS "INCIDENT ID",
  week                       AS "WEEK",
  shift                      AS "SHIFT",
  incident_date              AS "DATE",
  incident_time              AS "TIME",
  controller                 AS "CONTROLLER",
  driver_name                AS "NAME & SURNAME",
  contact_number             AS "CONTACT NUMBER",
  id_number                  AS "ID NUMBER",
  division                   AS "DIVISION",
  fleet_number               AS "FLEET #",
  infringement               AS "INFRINGEMENT",
  infringement_detail        AS "INFRINGEMENT DETAIL",
  action_taken               AS "ACTION TAKEN",
  outcome                    AS "OUTCOME",
  status                     AS "STATUS",
  document_link              AS "DOCUMENT LINK"
FROM incidents
ORDER BY incident_date DESC NULLS LAST, created_at DESC;