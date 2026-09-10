-- Store preview references without importing the obsolete process-local cache.
-- The shared writer owns ordering, uniqueness, and configured capacity.

ALTER TABLE "AccountThreadState"
  ADD COLUMN "previewSeqs" integer[] NOT NULL DEFAULT '{}'::integer[];
