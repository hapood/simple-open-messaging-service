CREATE TABLE "FederatedProfile" (
  "domain" VARCHAR(63) NOT NULL,
  "account" VARCHAR(31) NOT NULL,
  "revision" INTEGER NOT NULL,
  "displayName" VARCHAR(30) NOT NULL,
  "bio" VARCHAR(255) NOT NULL DEFAULT '',
  "avatar" VARCHAR(255),
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederatedProfile_pkey" PRIMARY KEY ("domain", "account"),
  CONSTRAINT "FederatedProfile_domain_fkey"
    FOREIGN KEY ("domain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederatedProfile_revision_check" CHECK ("revision" >= 0)
);

CREATE TABLE "FederatedFriendRequest" (
  "id" BIGSERIAL PRIMARY KEY,
  "localUserId" INTEGER NOT NULL,
  "remoteAccount" VARCHAR(31) NOT NULL,
  "remoteDomain" VARCHAR(63) NOT NULL,
  "direction" VARCHAR(16) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "note" VARCHAR(255) NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "requestedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "displayName" VARCHAR(30),
  "avatar" TEXT,
  "profileRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederatedFriendRequest_localUserId_fkey"
    FOREIGN KEY ("localUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "FederatedFriendRequest_remoteDomain_fkey"
    FOREIGN KEY ("remoteDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederatedFriendRequest_direction_check"
    CHECK ("direction" IN ('INCOMING', 'OUTGOING')),
  CONSTRAINT "FederatedFriendRequest_status_check"
    CHECK ("status" IN ('REQUESTED', 'REVOKED')),
  CONSTRAINT "FederatedFriendRequest_revision_check"
    CHECK ("revision" >= 0 AND ("profileRevision" IS NULL OR "profileRevision" >= 0)),
  CONSTRAINT "FederatedFriendRequest_expiry_check" CHECK (
    ("status" = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt" AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR ("status" = 'REVOKED' AND "expiresAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "FederatedFriendRequest_direction_key"
  ON "FederatedFriendRequest" ("localUserId", "remoteDomain", "remoteAccount", "direction");

CREATE INDEX "FederatedFriendRequest_pending_idx"
  ON "FederatedFriendRequest" ("localUserId", "direction", "status", "expiresAt");

CREATE TABLE "MemberProfileStateRevision" (
  "userId" INTEGER NOT NULL,
  "sourcePeerDomain" VARCHAR(63) NOT NULL,
  "memberAccount" VARCHAR(31) NOT NULL,
  "memberDomain" VARCHAR(63) NOT NULL,
  "revision" INTEGER NOT NULL,
  CONSTRAINT "MemberProfileStateRevision_pkey"
    PRIMARY KEY ("userId", "sourcePeerDomain", "memberAccount", "memberDomain"),
  CONSTRAINT "MemberProfileStateRevision_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "MemberProfileStateRevision_revision_check" CHECK ("revision" > 0)
);

CREATE INDEX "MemberProfileStateRevision_user_revision_idx"
  ON "MemberProfileStateRevision" ("userId", "revision");

ALTER TABLE "GroupMembershipRequest"
  ADD CONSTRAINT "GroupMembershipRequest_expiry_check" CHECK (
    (status = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt" AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR (status <> 'REQUESTED' AND "expiresAt" IS NULL)
  );

ALTER TABLE "FriendRequest"
  ADD CONSTRAINT "FriendRequest_expiry_check" CHECK (
    (status = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt" AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR (status <> 'REQUESTED' AND "expiresAt" IS NULL)
  );
