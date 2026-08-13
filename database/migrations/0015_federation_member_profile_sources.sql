CREATE TABLE "FederationMemberProfileSource" (
  "targetPeerDomain" VARCHAR(63) NOT NULL,
  "memberAccount" VARCHAR(31) NOT NULL,
  "memberDomain" VARCHAR(63) NOT NULL,
  "threadId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMemberProfileSource_pkey"
    PRIMARY KEY ("targetPeerDomain", "memberAccount", "memberDomain", "threadId"),
  CONSTRAINT "FederationMemberProfileSource_targetPeerDomain_fkey"
    FOREIGN KEY ("targetPeerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationMemberProfileSource_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE
);

CREATE INDEX "FederationMemberProfileSource_member_idx"
  ON "FederationMemberProfileSource" ("targetPeerDomain", "memberDomain", "memberAccount");

CREATE TABLE "FederationMemberProfilePublication" (
  "targetPeerDomain" VARCHAR(63) NOT NULL,
  "memberAccount" VARCHAR(31) NOT NULL,
  "memberDomain" VARCHAR(63) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "availability" VARCHAR(16) NOT NULL,
  "bodyHash" VARCHAR(64) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMemberProfilePublication_pkey"
    PRIMARY KEY ("targetPeerDomain", "memberAccount", "memberDomain"),
  CONSTRAINT "FederationMemberProfilePublication_targetPeerDomain_fkey"
    FOREIGN KEY ("targetPeerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationMemberProfilePublication_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "FederationMemberProfilePublication_availability_check"
    CHECK ("availability" IN ('AVAILABLE', 'REMOVED'))
);

CREATE TABLE "FederatedMemberProfile" (
  "sourcePeerDomain" VARCHAR(63) NOT NULL,
  "memberAccount" VARCHAR(31) NOT NULL,
  "memberDomain" VARCHAR(63) NOT NULL,
  "revision" INTEGER NOT NULL,
  "availability" VARCHAR(16) NOT NULL,
  "displayName" VARCHAR(30),
  "avatar" VARCHAR(255),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederatedMemberProfile_pkey"
    PRIMARY KEY ("sourcePeerDomain", "memberAccount", "memberDomain"),
  CONSTRAINT "FederatedMemberProfile_sourcePeerDomain_fkey"
    FOREIGN KEY ("sourcePeerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederatedMemberProfile_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "FederatedMemberProfile_availability_check"
    CHECK ("availability" IN ('AVAILABLE', 'REMOVED')),
  CONSTRAINT "FederatedMemberProfile_body_check" CHECK (
    ("availability" = 'AVAILABLE' AND "displayName" IS NOT NULL)
    OR ("availability" = 'REMOVED' AND "displayName" IS NULL AND "avatar" IS NULL)
  )
);
