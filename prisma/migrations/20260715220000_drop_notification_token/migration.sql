-- Drop the scoped notification-token table: the Android foreground service now consumes /events
-- directly (Kotlin-owned connection, session-token auth), so the separate /notifications/stream feed
-- and its scoped 30-day notification token are dead. Destructive — historical data not preserved.
DROP TABLE IF EXISTS "NotificationToken";
