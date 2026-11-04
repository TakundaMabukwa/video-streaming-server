\set ON_ERROR_STOP on
\timing on
DELETE FROM telematics_events t
USING (
  SELECT id, row_number() OVER (PARTITION BY device_id, event_code, event_time ORDER BY id) AS rn
  FROM telematics_events
) keep
WHERE t.id = keep.id AND keep.rn > 1;
ANALYZE telematics_events;