ALTER TABLE "MessageThread"
  ADD COLUMN "federationRoundsEnabled" boolean NOT NULL DEFAULT false;

UPDATE "MessageThread" thread
SET "federationRoundsEnabled" = true
WHERE (thread.type = 'GROUP' AND thread."groupDomain" = 'local')
   OR EXISTS (
     SELECT 1 FROM "RelationshipPair" pair
     WHERE pair."threadId" = thread.id AND pair.active = true
       AND (pair.kind = 'P2P'
         OR (pair.kind = 'GROUP_MEMBER' AND pair."endpointBDomain" = 'local'))
   );
