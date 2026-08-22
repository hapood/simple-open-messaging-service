ALTER TYPE "PeerStateEventType" RENAME TO "PeerStateEventType_legacy";

CREATE TYPE "PeerStateEventType" AS ENUM (
  'PROFILE',
  'MEMBER_PROFILE',
  'RELATIONSHIP_INTENT',
  'GROUP_META'
);

ALTER TABLE "PeerStateFeed"
  DROP CONSTRAINT IF EXISTS "PeerStateFeed_subject_check";

DELETE FROM "PeerStateFeed"
WHERE "eventType"::text IN ('P2P_INTENT', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT');

DELETE FROM "ClientStateFeed"
WHERE "eventType"::text IN ('P2P_INTENT', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT');

ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";

ALTER TABLE "ClientStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";

ALTER TABLE "PeerStateFeed"
  ADD CONSTRAINT "PeerStateFeed_subject_check" CHECK (
    ("eventType" = 'RELATIONSHIP_INTENT' AND "subjectAccount" <> '' AND "subjectDomain" <> '')
    OR
    ("eventType" <> 'RELATIONSHIP_INTENT' AND "subjectAccount" = '' AND "subjectDomain" = '')
  );

DROP TYPE "PeerStateEventType_legacy";

ALTER TABLE "FederatedFriendRequest"
  DROP CONSTRAINT "FederatedFriendRequest_status_check",
  DROP CONSTRAINT "FederatedFriendRequest_expiry_check",
  ADD CONSTRAINT "FederatedFriendRequest_status_check"
    CHECK (status IN ('REQUESTED', 'ACCEPTED', 'REVOKED')),
  ADD CONSTRAINT "FederatedFriendRequest_expiry_check" CHECK (
    (status = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt" AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR (status IN ('ACCEPTED', 'REVOKED') AND "expiresAt" IS NULL)
  );
