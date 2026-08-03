-- Local accounts are no longer aggregated into the server-domain quota bucket. Federated peers remain
-- domain-scoped; local accounts receive a separate userId-scoped quota model in a subsequent migration.
DELETE FROM "SystemSetting" WHERE "key" = 'quota:local';
