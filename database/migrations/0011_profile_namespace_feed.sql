-- Profile Namespace Feed: the shared identity-change serving table, its
-- per-peer pull progress, and the local namespace-info cache. The State Feed
-- pull cursor folds from its dedicated table onto IdentityNamespace as
-- stateFeedPulledThrough; NULL preserves the never-initialized distinction
-- that the cursor table encoded as initialized = false.

ALTER TABLE "IdentityNamespace"
  ADD COLUMN "stateFeedPulledThrough" bigint,
  ADD COLUMN "profileNamespaceFeedEndId" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "profileNamespaceFeedPulledThrough" bigint NOT NULL DEFAULT 0;

ALTER TABLE "IdentityNamespace"
  ADD CONSTRAINT "IdentityNamespace_stateFeedPulledThrough_check"
    CHECK ("stateFeedPulledThrough" IS NULL OR "stateFeedPulledThrough" >= 0),
  ADD CONSTRAINT "IdentityNamespace_profileNamespaceFeedEndId_check"
    CHECK ("profileNamespaceFeedEndId" >= 0 AND (id = 0 OR "profileNamespaceFeedEndId" = 0)),
  ADD CONSTRAINT "IdentityNamespace_profileNamespaceFeedPulledThrough_check"
    CHECK ("profileNamespaceFeedPulledThrough" >= 0);

-- Initialized cursors keep their committed progress; rows that had not yet
-- bootstrapped remain NULL because the column default is NULL.
UPDATE "IdentityNamespace" ns
SET "stateFeedPulledThrough" = c."committedThrough"
FROM "PeerStateFeedPullCursor" c
WHERE c."namespaceId" = ns.id AND c.initialized;

DROP TABLE "PeerStateFeedPullCursor";

-- One shared serving table: every peer pulls the same compacted items. The
-- body is the affected identity's namespace id, so the primary key carries it.
CREATE TABLE "ProfileNamespaceFeed" (
  "namespaceId" integer NOT NULL,
  "feedId" bigint NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileNamespaceFeed_pkey" PRIMARY KEY ("namespaceId"),
  CONSTRAINT "ProfileNamespaceFeed_namespace_fkey" FOREIGN KEY ("namespaceId")
    REFERENCES "IdentityNamespace"(id) ON DELETE RESTRICT,
  CONSTRAINT "ProfileNamespaceFeed_feedId_check" CHECK ("feedId" > 0)
);
CREATE UNIQUE INDEX "ProfileNamespaceFeed_feedId_key"
  ON "ProfileNamespaceFeed" USING btree ("feedId");

-- Local namespace-info cache: one row per publisher-scoped pair, tomb-friendly
-- (bindings both null while a first resolution is in flight).
CREATE TABLE "ProfileNamespaceInfo" (
  "publisherNamespaceId" integer NOT NULL,
  "profileNamespaceId" integer NOT NULL,
  "domain" varchar(63),
  "rootPublicKey" varchar(44),
  "updateFeedId" bigint NOT NULL DEFAULT 0,
  "expired" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileNamespaceInfo_pkey"
    PRIMARY KEY ("publisherNamespaceId", "profileNamespaceId"),
  CONSTRAINT "ProfileNamespaceInfo_publisher_fkey"
    FOREIGN KEY ("publisherNamespaceId")
    REFERENCES "IdentityNamespace"(id) ON DELETE RESTRICT,
  CONSTRAINT "ProfileNamespaceInfo_updateFeedId_check"
    CHECK ("updateFeedId" >= 0),
  CONSTRAINT "ProfileNamespaceInfo_bindings_check"
    CHECK (
      ("domain" IS NULL AND "rootPublicKey" IS NULL)
      OR ("domain" IS NOT NULL AND "rootPublicKey" IS NOT NULL)
    )
);
