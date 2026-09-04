-- Clean cut: revision zero is a reference sentinel and is never a stored profile.
-- Old profile data is intentionally discarded instead of translated.
DELETE FROM "ReferencedUserProfileVersion";
--> statement-breakpoint
DELETE FROM "ProfileVersion";
--> statement-breakpoint
DELETE FROM "GroupMetaMemberFeed";
--> statement-breakpoint
DELETE FROM "GroupMetaProfileFeed";
--> statement-breakpoint
DELETE FROM "ClientGroupMetaMemberFeed";
--> statement-breakpoint
DELETE FROM "FederatedFriendRequest";
--> statement-breakpoint
DELETE FROM "PeerStateFeed" WHERE body ? 'profileRev';
--> statement-breakpoint
DELETE FROM "ClientStateFeed" WHERE body ? 'profileRev';
--> statement-breakpoint
UPDATE "User" SET "defaultProfileRev" = 0;
--> statement-breakpoint
UPDATE "Group" SET "defaultProfileRev" = 0;
--> statement-breakpoint
UPDATE "Message" SET "profileRev" = 0;
--> statement-breakpoint
UPDATE "ThreadMember" SET "profileRev" = 0, "profileMessageSeq" = NULL;
--> statement-breakpoint
UPDATE "RelationshipIntent" SET "profileRev" = 0;
--> statement-breakpoint
ALTER TABLE "User"
  ADD CONSTRAINT "User_defaultProfileRev_check" CHECK ("defaultProfileRev" >= 0);
--> statement-breakpoint
ALTER TABLE "ProfileVersion" DROP CONSTRAINT "ProfileVersion_profileRev_check";
--> statement-breakpoint
ALTER TABLE "ProfileVersion"
  ADD CONSTRAINT "ProfileVersion_profileRev_check" CHECK ("profileRev" > 0);
--> statement-breakpoint
ALTER TABLE "ReferencedUserProfileVersion"
  DROP CONSTRAINT "ReferencedUserProfileVersion_profileRev_check";
--> statement-breakpoint
ALTER TABLE "ReferencedUserProfileVersion"
  ADD CONSTRAINT "ReferencedUserProfileVersion_profileRev_check" CHECK ("profileRev" > 0);
--> statement-breakpoint
ALTER TABLE "FederatedFriendRequest"
  ALTER COLUMN "profileRevision" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "FederatedFriendRequest"
  ALTER COLUMN "profileRevision" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "FederatedFriendRequest"
  DROP CONSTRAINT "FederatedFriendRequest_profileRevision_check";
--> statement-breakpoint
ALTER TABLE "FederatedFriendRequest"
  ADD CONSTRAINT "FederatedFriendRequest_profileRevision_check"
  CHECK ("profileRevision" >= 0);
--> statement-breakpoint
ALTER TABLE "ClientGroupMetaMemberFeed"
  DROP CONSTRAINT "ClientGroupMetaMemberFeed_body_check";
--> statement-breakpoint
ALTER TABLE "ClientGroupMetaMemberFeed"
  ADD CONSTRAINT "ClientGroupMetaMemberFeed_body_check" CHECK (body <> '{}'::jsonb);
