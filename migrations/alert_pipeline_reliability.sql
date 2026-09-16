-- ============================================================================
-- Migration: alert pipeline reliability
-- Adds: sync_state, soltrack_unknown, telematics_events dedup + unique index
-- Idempotent: safe to run multiple times.
-- ============================================================================

BEGIN;

-- ── 1. sync_state: persistent cursor / high-water marks ────────────────────
CREATE TABLE IF NOT EXISTS public.sync_state (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. soltrack_unknown: diagnostic buffer for unknown registrations ───────
CREATE TABLE IF NOT EXISTS public.soltrack_unknown (
    id           bigserial PRIMARY KEY,
    reg          text NOT NULL,
    frame        jsonb,
    reason       text,
    first_seen   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    seen_count   integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_soltrack_unknown_reg ON public.soltrack_unknown (reg);
CREATE UNIQUE INDEX IF NOT EXISTS idx_soltrack_unknown_reg_unique ON public.soltrack_unknown (upper(replace(trim(reg), ' ', '')));

-- ── 3. telematics_events dedup ──────────────────────────────────────────────
-- Remove duplicate rows (keep the earliest id per device+event+time),
-- then add a unique index so ON CONFLICT DO NOTHING actually works.
-- Uses a window function (O(n log n)) instead of a self-join DELETE.

DO $$
DECLARE
  dup_count bigint;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM telematics_events t
  WHERE t.id NOT IN (
    SELECT MIN(t2.id)
    FROM telematics_events t2
    GROUP BY t2.device_id, t2.event_code, t2.event_time
  );

  IF dup_count > 0 THEN
    RAISE NOTICE 'telematics_events: removing % duplicate rows', dup_count;

    DELETE FROM telematics_events t
    USING (
      SELECT id, row_number() OVER (
        PARTITION BY device_id, event_code, event_time
        ORDER BY id
      ) AS rn
      FROM telematics_events
    ) keep
    WHERE t.id = keep.id AND keep.rn > 1;
  ELSE
    RAISE NOTICE 'telematics_events: no duplicates found';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telematics_events_dedup
  ON public.telematics_events (device_id, event_code, event_time);

-- Convenience index for speed lookups already used by controllers
CREATE INDEX IF NOT EXISTS idx_telematics_events_fleet_time
  ON public.telematics_events (fleet_number, event_time DESC);

COMMIT;

-- ============================================================================
-- Post-apply checks (run manually to confirm):
--   SELECT COUNT(*) FROM telematics_events;
--   SELECT COUNT(*) - COUNT(DISTINCT (device_id, event_code, event_time)) 
--   FROM telematics_events;  -- expect 0
-- ============================================================================