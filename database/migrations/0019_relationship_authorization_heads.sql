ALTER TABLE "RelationshipIntent"
  ADD COLUMN "messageEndSeq" integer,
  ADD COLUMN "tombstoneEndSeq" integer,
  ADD CONSTRAINT "RelationshipIntent_head_check" CHECK (
    ("messageEndSeq" IS NULL AND "tombstoneEndSeq" IS NULL) OR
    ("messageEndSeq" IS NOT NULL AND "tombstoneEndSeq" IS NOT NULL
      AND "messageEndSeq" >= 0 AND "tombstoneEndSeq" >= 0)
  );
