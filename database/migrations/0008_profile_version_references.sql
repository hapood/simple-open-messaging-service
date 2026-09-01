ALTER TABLE "User" RENAME COLUMN "profileRev" TO "defaultProfileRev";
--> statement-breakpoint
ALTER TABLE "Group" DROP CONSTRAINT "Group_profileRev_check";
--> statement-breakpoint
ALTER TABLE "Group" RENAME COLUMN "profileRev" TO "defaultProfileRev";
--> statement-breakpoint
ALTER TABLE "Group" ADD CONSTRAINT "Group_defaultProfileRev_check" CHECK ("defaultProfileRev" >= 0);
--> statement-breakpoint
CREATE TABLE "ProfileVersion" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "userId" integer,
  "groupId" integer,
  "profileRev" integer NOT NULL,
  "displayName" varchar(30) NOT NULL,
  "avatar" text DEFAULT '' NOT NULL,
  "bio" varchar(255) DEFAULT '' NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ProfileVersion_owner_check" CHECK (("userId" IS NOT NULL) <> ("groupId" IS NOT NULL)),
  CONSTRAINT "ProfileVersion_profileRev_check" CHECK ("profileRev" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ProfileVersion_userId_profileRev_key" ON "ProfileVersion" USING btree ("userId", "profileRev") WHERE "userId" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "ProfileVersion_groupId_profileRev_key" ON "ProfileVersion" USING btree ("groupId", "profileRev") WHERE "groupId" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "ProfileVersion" ADD CONSTRAINT "ProfileVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ProfileVersion" ADD CONSTRAINT "ProfileVersion_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "ProfileVersion" (
  "userId", "profileRev", "displayName", "avatar", "bio", "createdAt"
)
SELECT id, "defaultProfileRev", name, avatar, bio, "updatedAt"
FROM "User";
--> statement-breakpoint
INSERT INTO "ProfileVersion" (
  "groupId", "profileRev", "displayName", "avatar", "bio", "createdAt"
)
SELECT id, "defaultProfileRev", name, avatar, description, "updatedAt"
FROM "Group";
--> statement-breakpoint
CREATE TABLE "ReferencedUserProfileVersion" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "userId" integer NOT NULL,
  "profileRev" integer NOT NULL,
  "displayName" varchar(30) NOT NULL,
  "avatar" text DEFAULT '' NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ReferencedUserProfileVersion_profileRev_check" CHECK ("profileRev" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ReferencedUserProfileVersion_userId_profileRev_key" ON "ReferencedUserProfileVersion" USING btree ("userId", "profileRev");
--> statement-breakpoint
ALTER TABLE "ReferencedUserProfileVersion" ADD CONSTRAINT "ReferencedUserProfileVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "Message" ADD COLUMN "profileRev" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "Message_profileRev_check" CHECK ("profileRev" >= 0);
--> statement-breakpoint
ALTER TABLE "RelationshipIntent" ADD COLUMN "profileRev" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "RelationshipIntent" ADD CONSTRAINT "RelationshipIntent_profileRev_check" CHECK ("profileRev" >= 0);
--> statement-breakpoint
ALTER TABLE "ThreadMember" ADD COLUMN "profileRev" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ThreadMember" ADD COLUMN "profileMessageSeq" integer;
--> statement-breakpoint
ALTER TABLE "ThreadMember" ADD CONSTRAINT "ThreadMember_profileRev_check" CHECK ("profileRev" >= 0);
--> statement-breakpoint
ALTER TABLE "ThreadMember" ADD CONSTRAINT "ThreadMember_profileMessageSeq_check" CHECK ("profileMessageSeq" IS NULL OR "profileMessageSeq" > 0);
--> statement-breakpoint
CREATE TABLE "GroupMetaProfileFeed" (
  "targetPeerDomain" varchar(63) NOT NULL,
  "targetNamespaceId" integer NOT NULL,
  "groupId" integer NOT NULL,
  "feedId" bigint NOT NULL,
  "profileRev" integer NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMetaProfileFeed_pkey" PRIMARY KEY("targetNamespaceId", "groupId"),
  CONSTRAINT "GroupMetaProfileFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "GroupMetaProfileFeed_profileRev_check" CHECK ("profileRev" >= 0)
);
--> statement-breakpoint
ALTER TABLE "GroupMetaProfileFeed" ADD CONSTRAINT "GroupMetaProfileFeed_targetNamespace_fkey" FOREIGN KEY ("targetPeerDomain", "targetNamespaceId") REFERENCES "public"."IdentityNamespace"("domain", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "GroupMetaProfileFeed" ADD CONSTRAINT "GroupMetaProfileFeed_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DELETE FROM "PeerStateFeed" WHERE "eventType" = 'PROFILE';
--> statement-breakpoint
ALTER TABLE "PeerStateFeed" DROP CONSTRAINT "PeerStateFeed_subject_check";
--> statement-breakpoint
ALTER TYPE "PeerStateEventType" RENAME TO "PeerStateEventType_legacy";
--> statement-breakpoint
CREATE TYPE "PeerStateEventType" AS ENUM(
  'RELATIONSHIP_INTENT',
  'GROUP_META_FEED_HEAD',
  'THREAD_CONTENT_HEAD'
);
--> statement-breakpoint
ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";
--> statement-breakpoint
DROP TYPE "PeerStateEventType_legacy";
--> statement-breakpoint
ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_subject_check" CHECK (
  ("eventType" = 'RELATIONSHIP_INTENT' AND "subjectAccount" <> '' AND "subjectDomain" <> '')
  OR ("eventType" = 'THREAD_CONTENT_HEAD' AND (("account" LIKE '!%' AND "subjectAccount" = '' AND "subjectDomain" = 'local') OR ("account" NOT LIKE '!%' AND "subjectAccount" <> '' AND "subjectDomain" = "peerDomain")))
  OR ("eventType" = 'GROUP_META_FEED_HEAD' AND "subjectAccount" = '' AND "subjectDomain" = 'local')
);
