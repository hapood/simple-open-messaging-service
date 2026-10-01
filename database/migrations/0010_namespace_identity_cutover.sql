-- Breaking namespace-coordinate naming cutover. Existing rows are not
-- backfilled because the removed domain columns were part of old identity
-- coordinates. Reset populated instances before applying this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Message" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "DeletedMessage" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "FederatedMessageTombstone" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "ForwardBundle" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "PendingMedia" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "FileSyncProgress" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "GroupRequestProjection" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "GroupMetaMemberFeed" LIMIT 1) THEN
    RAISE EXCEPTION '0010_namespace_identity_cutover requires empty message/federation/group-meta tables; reset old data instead of backfilling obsolete domain coordinates';
  END IF;
END $$;

-- Publisher namespace naming.
ALTER TABLE "ForwardBundle"
  DROP CONSTRAINT IF EXISTS "ForwardBundle_sourceNamespaceId_fkey";
DROP INDEX IF EXISTS "ForwardBundle_sourceNamespace_sourceBundleId_key";
ALTER TABLE "ForwardBundle"
  RENAME COLUMN "sourceNamespaceId" TO "publisherNamespaceId";
CREATE UNIQUE INDEX "ForwardBundle_publisherNamespace_sourceBundleId_key"
  ON "ForwardBundle" USING btree ("publisherNamespaceId", "sourceBundleId");
ALTER TABLE "ForwardBundle"
  ADD CONSTRAINT "ForwardBundle_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

ALTER TABLE "Message"
  DROP CONSTRAINT IF EXISTS "Message_sourceNamespaceId_fkey",
  DROP CONSTRAINT IF EXISTS "Message_origin_seq_check",
  DROP CONSTRAINT IF EXISTS "Message_system_creator_check";
DROP INDEX IF EXISTS "Message_creator_address_idx";
DROP INDEX IF EXISTS "Message_threadId_source_originSeq_key";
ALTER TABLE "Message"
  RENAME COLUMN "sourceNamespaceId" TO "publisherNamespaceId";
ALTER TABLE "Message"
  DROP CONSTRAINT IF EXISTS "Message_profile_namespace_check",
  DROP CONSTRAINT IF EXISTS "Message_system_creator_check";
ALTER TABLE "Message"
  DROP COLUMN IF EXISTS "creatorDomain";
CREATE INDEX "Message_creator_address_idx"
  ON "Message" USING btree ("creatorAccount", "profileNamespaceId", "publisherNamespaceId");
CREATE UNIQUE INDEX "Message_threadId_source_originSeq_key"
  ON "Message" USING btree ("threadId", "publisherNamespaceId", "originSeq");
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT "Message_origin_seq_check"
  CHECK ("publisherNamespaceId" = 0 OR ("originSeq" IS NOT NULL AND "originSeq" > 0)),
  ADD CONSTRAINT "Message_system_creator_check"
  CHECK (
    "creatorAccount" IS NOT NULL
    AND (
      (
        "contentType" = 'SYSTEM'
        AND "creatorAccount" = '$system'
        AND "profileNamespaceId" = 0
        AND "profileRev" = 0
        AND "publisherNamespaceId" = 0
      )
      OR ("contentType" <> 'SYSTEM' AND "creatorAccount" <> '$system')
    )
  );

ALTER TABLE "DeletedMessage"
  DROP CONSTRAINT IF EXISTS "DeletedMessage_sourceNamespaceId_fkey";
ALTER TABLE "DeletedMessage"
  RENAME COLUMN "sourceNamespaceId" TO "publisherNamespaceId";
ALTER TABLE "DeletedMessage"
  ADD CONSTRAINT "DeletedMessage_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

ALTER TABLE "FederatedMessageTombstone"
  DROP CONSTRAINT IF EXISTS "FederatedMessageTombstone_sourceNamespaceId_fkey";
DROP INDEX IF EXISTS "FederatedMessageTombstone_target_key";
DROP INDEX IF EXISTS "FederatedMessageTombstone_source_event_key";
ALTER TABLE "FederatedMessageTombstone"
  RENAME COLUMN "sourceNamespaceId" TO "publisherNamespaceId";
CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key"
  ON "FederatedMessageTombstone" USING btree ("threadId", "publisherNamespaceId", "messageSeq");
CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key"
  ON "FederatedMessageTombstone" USING btree ("publisherNamespaceId", "threadId", "remoteDeletionSeq");
ALTER TABLE "FederatedMessageTombstone"
  ADD CONSTRAINT "FederatedMessageTombstone_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

ALTER TABLE "PendingMedia"
  DROP CONSTRAINT IF EXISTS "PendingMedia_namespaceId_fkey";
ALTER TABLE "PendingMedia"
  RENAME COLUMN "namespaceId" TO "publisherNamespaceId";
ALTER TABLE "PendingMedia"
  ADD CONSTRAINT "PendingMedia_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

ALTER TABLE "FileSyncProgress"
  DROP CONSTRAINT IF EXISTS "FileSyncProgress_namespaceId_fkey";
ALTER TABLE "FileSyncProgress"
  RENAME COLUMN "namespaceId" TO "publisherNamespaceId";
ALTER TABLE "FileSyncProgress"
  ADD CONSTRAINT "FileSyncProgress_publisherNamespaceId_fkey"
  FOREIGN KEY ("publisherNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

-- Profile identity no longer includes domain.
ALTER TABLE "Profile"
  DROP CONSTRAINT IF EXISTS "Profile_pkey";
ALTER TABLE "Profile"
  DROP COLUMN IF EXISTS domain;
ALTER TABLE "Profile"
  ADD CONSTRAINT "Profile_pkey"
  PRIMARY KEY ("publisherNamespaceId", account, "profileNamespaceId", "profileRev");

-- Group request/member identity uses profile namespace, not domain.
ALTER TABLE "GroupRequestProjection"
  DROP CONSTRAINT IF EXISTS "GroupRequestProjection_memberNamespaceId_fkey",
  DROP CONSTRAINT IF EXISTS "GroupRequestProjection_pkey";
ALTER TABLE "GroupRequestProjection"
  DROP COLUMN IF EXISTS "memberDomain";
ALTER TABLE "GroupRequestProjection"
  RENAME COLUMN "memberNamespaceId" TO "profileNamespaceId";
ALTER TABLE "GroupRequestProjection"
  ADD CONSTRAINT "GroupRequestProjection_pkey"
  PRIMARY KEY ("threadId", "memberAccount", "profileNamespaceId", direction),
  ADD CONSTRAINT "GroupRequestProjection_profileNamespaceId_fkey"
  FOREIGN KEY ("profileNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE CASCADE;

DROP INDEX IF EXISTS "GroupMetaMemberFeed_member_key";
ALTER TABLE "GroupMetaMemberFeed"
  DROP COLUMN IF EXISTS "memberDomain";
ALTER TABLE "GroupMetaMemberFeed"
  ADD COLUMN "profileNamespaceId" integer NOT NULL;
CREATE UNIQUE INDEX "GroupMetaMemberFeed_member_key"
  ON "GroupMetaMemberFeed" USING btree ("threadId", "memberAccount", "profileNamespaceId");
ALTER TABLE "GroupMetaMemberFeed"
  ADD CONSTRAINT "GroupMetaMemberFeed_profileNamespaceId_fkey"
  FOREIGN KEY ("profileNamespaceId") REFERENCES "IdentityNamespace"(id)
  ON DELETE RESTRICT;

-- No runtime path derives member identity from domain after the cutover.
DROP FUNCTION IF EXISTS public.group_meta_member_namespace(integer, text, text);

-- ThreadAudience no longer stores targetDomain; local/peer distinction is
-- encoded by localUserId (NOT NULL = local, NULL = peer) and
-- targetNamespaceId (0 = local, >0 = peer).
ALTER TABLE "ThreadAudience"
  DROP CONSTRAINT IF EXISTS "ThreadAudience_target_check";
DROP INDEX IF EXISTS "ThreadAudience_local_key";
DROP INDEX IF EXISTS "ThreadAudience_peer_key";
DROP INDEX IF EXISTS "ThreadAudience_local_access_idx";
DROP INDEX IF EXISTS "ThreadAudience_peer_access_idx";
ALTER TABLE "ThreadAudience"
  DROP COLUMN IF EXISTS "targetDomain";
ALTER TABLE "ThreadAudience"
  ADD CONSTRAINT "ThreadAudience_target_check"
  CHECK ("localUserId" IS NOT NULL AND "targetNamespaceId" = 0
      OR "localUserId" IS NULL AND "targetNamespaceId" > 0);
CREATE UNIQUE INDEX "ThreadAudience_local_key"
  ON "ThreadAudience" ("localUserId", "threadId")
  WHERE "localUserId" IS NOT NULL;
CREATE UNIQUE INDEX "ThreadAudience_peer_key"
  ON "ThreadAudience" ("targetNamespaceId", "threadId")
  WHERE "localUserId" IS NULL;
CREATE INDEX "ThreadAudience_local_access_idx"
  ON "ThreadAudience" ("localUserId", "threadId")
  WHERE "localUserId" IS NOT NULL;
CREATE INDEX "ThreadAudience_peer_access_idx"
  ON "ThreadAudience" ("targetNamespaceId", "threadId")
  WHERE "localUserId" IS NULL;

-- PeerStateFeed no longer stores the redundant peerDomain column; the
-- namespaceId column already uniquely identifies the feed's namespace
-- (publisher namespace id) and every query joined peerDomain with
-- namespaceId. The unique index name is normalized to match its actual
-- columns (namespaceId, feedId).
DROP INDEX IF EXISTS "PeerStateFeed_peerDomain_feedId_key";
ALTER TABLE "PeerStateFeed"
  DROP COLUMN IF EXISTS "peerDomain";
CREATE UNIQUE INDEX "PeerStateFeed_namespace_feedId_key"
  ON "PeerStateFeed" ("namespaceId", "feedId");

-- PeerStateFeed.domain was always 'local' (the feed only carries this server's
-- own outbound state) and was never transmitted on the wire. Drop the redundant
-- column and rebuild the primary key without it.
ALTER TABLE "PeerStateFeed"
  DROP CONSTRAINT IF EXISTS "PeerStateFeed_pkey";
ALTER TABLE "PeerStateFeed"
  DROP COLUMN IF EXISTS "domain";
ALTER TABLE "PeerStateFeed"
  ADD CONSTRAINT "PeerStateFeed_pkey"
  PRIMARY KEY ("namespaceId", "account", "eventType", "subjectAccount", "subjectNamespaceId");
