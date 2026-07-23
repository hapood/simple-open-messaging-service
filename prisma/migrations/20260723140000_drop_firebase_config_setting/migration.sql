-- Drop the now-dead `firebase-config` SystemSetting row. The Firebase client config moved from a DB-backed
-- admin-web upload (stored under this key by the since-removed SettingsService.setFirebaseConfig /
-- parseFirebase / refresh-fbRow path) to a file on disk (FIREBASE_CLIENT_CONFIG / data/google-services.json)
-- on 2026-07-23. The row is no longer read or written by any code path. Idempotent — a no-op on deploys that
-- never used the old upload model (the row was never created there).
DELETE FROM "SystemSetting" WHERE key = 'firebase-config';
