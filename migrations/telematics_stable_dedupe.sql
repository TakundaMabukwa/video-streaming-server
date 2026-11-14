-- ============================================================================
-- Migration: provider-stable telematics dedupe
--
-- Problem: telematics_events deduped on (device_id, event_code, event_time)
-- where device_id is the RESOLVED fleet number. Any fleet rename / registry
-- re-map changed the key, so already-stored records were re-inserted and
-- re-alerted as new. Geotab also re-publishes modified records with their
-- original activeFrom, which made the replay visible as old-dated alerts.
--
-- Fix: dedupe on the provider's own identity — source_device_id (raw Geotab
-- device id, stable across renames) + event_code + event_time. Existing exact
-- duplicates are collapsed (earliest row kept) and a partial unique index
-- enforces the invariant.
--
-- Single pass over the table: duplicates are identified and deleted in one
-- statement, then the index is built. Idempotent: safe to run multiple times.
--
-- NOTE: the server also applies this same step on every boot
-- (TELEMATICS_DEDUPE_SQL in src/db/schema.js), so a normal container rebuild
-- needs no manual migration. This file remains for ops/manual use.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  removed bigint := 0;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY source_device_id, event_code, event_time
      ORDER BY id
    ) AS rn
    FROM public.telematics_events
    WHERE source_device_id IS NOT NULL
  )
  DELETE FROM public.telematics_events t
  USING ranked
  WHERE t.id = ranked.id AND ranked.rn > 1;

  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'telematics_events: collapsed % provider-identity duplicate(s)', removed;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telematics_events_src_key
  ON public.telematics_events (source_device_id, event_code, event_time)
  WHERE source_device_id IS NOT NULL;

COMMIT;

-- ============================================================================
-- Post-apply check (expect 0):
--   SELECT count(*) - count(DISTINCT (source_device_id, event_code, event_time))
--   FROM telematics_events WHERE source_device_id IS NOT NULL;
-- ============================================================================
