-- The shared request projection is keyed by group, member address, and direction.
-- Relationship intent ids and generic row timestamps are not used by readers or writers.
ALTER TABLE public."GroupRequestProjection"
  DROP COLUMN "requestId",
  DROP COLUMN "createdAt",
  DROP COLUMN "updatedAt";
