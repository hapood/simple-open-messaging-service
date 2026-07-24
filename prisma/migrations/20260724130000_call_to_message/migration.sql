-- Calls are now ContentType.CALL Message bubbles (server-authored by CallsService at the call's
-- terminal state), not a dedicated Call table. This reverses 20260724120000_add_call (drop the
-- Call model + its CallType/CallStatus enums) and adds the CALL content type the bubbles use.
-- Non-breaking on existing Message rows: a new enum value adds a kind, it does not alter any.

DROP TABLE IF EXISTS "Call";
DROP TYPE IF EXISTS "CallStatus";
DROP TYPE IF EXISTS "CallType";

-- ADD VALUE is permitted inside a transaction block since PostgreSQL 12 (this server is PG 16).
ALTER TYPE "ContentType" ADD VALUE IF NOT EXISTS 'CALL';
