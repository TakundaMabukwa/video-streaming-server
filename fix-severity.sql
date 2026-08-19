ALTER TABLE alert_group_configs ALTER COLUMN severity DROP NOT NULL;
ALTER TABLE alert_group_configs ALTER COLUMN severity TYPE text USING severity::text;
ALTER TABLE alert_group_configs ALTER COLUMN severity SET DEFAULT 'MEDIUM';
ALTER TABLE alert_group_configs ALTER COLUMN severity SET NOT NULL;
