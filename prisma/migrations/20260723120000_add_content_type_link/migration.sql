-- Add LINK to the ContentType enum (web link card / OpenGraph preview message kind).
-- Non-breaking: existing rows keep their values; new value defaults are not changed.
-- ADD VALUE is permitted inside a transaction block since PostgreSQL 12.
ALTER TYPE "ContentType" ADD VALUE IF NOT EXISTS 'LINK';
