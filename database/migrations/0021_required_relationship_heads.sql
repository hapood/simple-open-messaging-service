-- Local authored snapshots can be obtained from local data in one statement.
UPDATE "RelationshipIntent" intent
SET "messageEndSeq" = COALESCE((
      SELECT MAX(m.seq) FROM "Message" m
      WHERE m."threadId" = pair."threadId" AND m."contentType" <> 'SYSTEM'
    ), 0),
    "tombstoneEndSeq" = COALESCE((
      SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
      JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
      WHERE d."threadId" = pair."threadId" AND d."sourceNamespaceId" = 0
    ), 0)
FROM "RelationshipPair" pair
WHERE pair.id = intent."pairId"
  AND (intent."messageEndSeq" IS NULL OR intent."tombstoneEndSeq" IS NULL)
  AND CASE intent."authorSide" WHEN 'A' THEN pair."endpointADomain"
    ELSE pair."endpointBDomain" END = 'local';

-- A revocation without a previous grant has no authorized history baseline.
UPDATE "RelationshipIntent"
SET "messageEndSeq" = 0, "tombstoneEndSeq" = 0
WHERE status = 'REVOKED'
  AND ("messageEndSeq" IS NULL OR "tombstoneEndSeq" IS NULL);

-- Unknown remote positive snapshots cannot be reconstructed or replaced by zero.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "RelationshipIntent"
    WHERE "messageEndSeq" IS NULL OR "tombstoneEndSeq" IS NULL) THEN
    RAISE EXCEPTION 'remote positive relationship intents require valid source snapshots before migration';
  END IF;
END $$;

ALTER TABLE "RelationshipIntent"
  ALTER COLUMN "messageEndSeq" SET NOT NULL,
  ALTER COLUMN "tombstoneEndSeq" SET NOT NULL,
  DROP CONSTRAINT "RelationshipIntent_head_check",
  ADD CONSTRAINT "RelationshipIntent_head_check"
    CHECK ("messageEndSeq" >= 0 AND "tombstoneEndSeq" >= 0);
