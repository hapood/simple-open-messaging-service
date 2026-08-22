DELETE FROM "GroupMembershipRequest";
DELETE FROM "GroupMembershipPair";
DELETE FROM "FriendRequest";
DELETE FROM "FriendPair";

DROP TABLE "GroupMembershipRequest";
DROP TABLE "GroupMembershipPair";
DROP TYPE "GroupMembershipDirection";
DROP TYPE "GroupMembershipRequestStatus";

ALTER TYPE "FriendRequestStatus" RENAME TO "RelationshipIntentStatus";
ALTER TYPE "RelationshipIntentStatus" RENAME VALUE 'FRIEND' TO 'ACCEPTED';
ALTER TYPE "RelationshipIntentStatus" RENAME VALUE 'NOT_FRIEND' TO 'REVOKED';

ALTER TABLE "FriendRequest" RENAME TO "RelationshipIntent";
ALTER TABLE "RelationshipIntent" RENAME COLUMN "requesterUserId" TO "authorUserId";
ALTER TABLE "RelationshipIntent" RENAME COLUMN "targetUserId" TO "subjectUserId";
ALTER SEQUENCE "FriendRequest_id_seq" RENAME TO "RelationshipIntent_id_seq";

ALTER TABLE "FriendPair" RENAME TO "RelationshipPair";
