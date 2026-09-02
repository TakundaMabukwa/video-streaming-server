-- Fix fleet numbers in geotab_devices extracted from device names.
-- For names like "32 - EX55 - LCL660MP", the old extractFleetNumber() returned "32"
-- (everything before the first dash). The corrected function picks the segment
-- that looks like a fleet code (starts with 2+ letters, e.g. "EX55").
--
-- Run once after deploying the extractFleetNumber() fix.

-- Step 1: Create a helper function
CREATE OR REPLACE FUNCTION reextract_fleet_number(device_name TEXT)
RETURNS TEXT AS $$
DECLARE
  parts TEXT[];
  part TEXT;
BEGIN
  IF device_name IS NULL OR position(' - ' in device_name) = 0 THEN
    RETURN NULL;
  END IF;
  parts := regexp_split_to_array(trim(device_name), '\s*[-–]\s*');
  FOREACH part IN ARRAY parts LOOP
    IF part ~ '^[A-Za-z]{2,}\d*$' THEN
      RETURN part;
    END IF;
  END LOOP;
  RETURN parts[1]; -- fallback to first segment
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Step 2: Update all devices with ' - ' in their name
UPDATE geotab_devices
SET fleet_number = reextract_fleet_number(name)
WHERE name LIKE '% - %';

-- Step 3: Clean up
DROP FUNCTION reextract_fleet_number;
