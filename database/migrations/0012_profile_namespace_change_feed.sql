-- Client-facing profile-namespace change feed. The serving table
-- (ProfileNamespaceFeed, 0011) is publisher-scoped: it records OUR namespace
-- binding changes for peers to pull. Peer-learned changes update
-- ProfileNamespaceInfo only, so clients need a separate, merged, compacted
-- changelog spanning both sources. Items carry no data: a client that has
-- pulled the feed but not yet resolved the pair's cache holds a tomb and
-- converges through profile-namespaces/resolve.

CREATE TABLE "ProfileNamespaceChangeFeed" (
  "publisherNamespaceId" integer NOT NULL,
  "profileNamespaceId" integer NOT NULL,
  "changeId" bigint NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileNamespaceChangeFeed_pkey"
    PRIMARY KEY ("publisherNamespaceId", "profileNamespaceId"),
  CONSTRAINT "ProfileNamespaceChangeFeed_publisher_fkey"
    FOREIGN KEY ("publisherNamespaceId")
    REFERENCES "IdentityNamespace"(id) ON DELETE RESTRICT,
  CONSTRAINT "ProfileNamespaceChangeFeed_changeId_check"
    CHECK ("changeId" > 0)
);
CREATE UNIQUE INDEX "ProfileNamespaceChangeFeed_changeId_key"
  ON "ProfileNamespaceChangeFeed" USING btree ("changeId");

-- Single-row allocator; row 0 mirrors the serving feed's IdentityNamespace
-- row-0 sentinel pattern. Writers lock this row terminally inside the same
-- transaction as the binding change it publishes.
CREATE TABLE "ProfileNamespaceChangeFeedHead" (
  "id" integer NOT NULL,
  "endId" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "ProfileNamespaceChangeFeedHead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProfileNamespaceChangeFeedHead_id_check" CHECK ("id" = 0),
  CONSTRAINT "ProfileNamespaceChangeFeedHead_endId_check"
    CHECK ("endId" >= 0)
);
INSERT INTO "ProfileNamespaceChangeFeedHead" ("id", "endId") VALUES (0, 0);
