ALTER TABLE "ThreadParticipant"
  ADD COLUMN "recognizesFriend" boolean DEFAULT true NOT NULL,
  ADD COLUMN "relationshipRev" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "remoteRelationshipRev" integer,
  ADD CONSTRAINT "ThreadParticipant_relationship_rev_check"
    CHECK ("relationshipRev" >= 0 AND ("remoteRelationshipRev" IS NULL OR "remoteRelationshipRev" >= 0));
