ALTER TABLE "PeerStateFeed"
  DROP CONSTRAINT IF EXISTS "PeerStateFeed_revision_check",
  DROP COLUMN "revision";

ALTER TABLE "ClientStateFeed"
  DROP CONSTRAINT IF EXISTS "ClientStateFeed_business_revision_check",
  DROP COLUMN "businessRevision";

ALTER TABLE "FederatedFriendRequest"
  DROP CONSTRAINT IF EXISTS "FederatedFriendRequest_revision_check",
  DROP COLUMN "revision",
  ADD CONSTRAINT "FederatedFriendRequest_profileRevision_check"
    CHECK ("profileRevision" IS NULL OR "profileRevision" >= 0);

ALTER TABLE "FriendRequest"
  DROP CONSTRAINT IF EXISTS "FriendRequest_revision_check",
  DROP COLUMN "revision",
  ADD CONSTRAINT "FriendRequest_distinct_users_check"
    CHECK ("requesterUserId" <> "targetUserId");

ALTER TABLE "GroupMembershipRequest"
  DROP CONSTRAINT IF EXISTS "GroupMembershipRequest_revision_check",
  DROP COLUMN "revision",
  ADD CONSTRAINT "GroupMembershipRequest_distinct_users_check"
    CHECK ("groupUserId" <> "memberUserId");
