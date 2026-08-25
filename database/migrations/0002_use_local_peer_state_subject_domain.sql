ALTER TABLE "PeerStateFeed"
  DROP CONSTRAINT "PeerStateFeed_subject_check";

UPDATE "PeerStateFeed"
SET "subjectDomain" = 'local'
WHERE "eventType" <> 'RELATIONSHIP_INTENT'
  AND "subjectAccount" = ''
  AND "subjectDomain" = '';

ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "subjectDomain" SET DEFAULT 'local';

ALTER TABLE "PeerStateFeed"
  ADD CONSTRAINT "PeerStateFeed_subject_check"
  CHECK (
    ("eventType" = 'RELATIONSHIP_INTENT' AND "subjectAccount" <> '' AND "subjectDomain" <> '')
    OR
    ("eventType" <> 'RELATIONSHIP_INTENT' AND "subjectAccount" = '' AND "subjectDomain" = 'local')
  );

UPDATE "ClientStateFeed"
SET "subjectDomain" = 'local'
WHERE "subjectDomain" = '';

ALTER TABLE "ClientStateFeed"
  ALTER COLUMN "subjectDomain" SET DEFAULT 'local';
