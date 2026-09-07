-- This identity-model cutover requires an empty business database. It never converts or repairs historical data.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "User") OR EXISTS (SELECT 1 FROM "Group")
    OR EXISTS (SELECT 1 FROM "MessageThread") OR EXISTS (SELECT 1 FROM "Message")
    OR EXISTS (SELECT 1 FROM "ProfileVersion") THEN
    RAISE EXCEPTION 'Account/profile cutover requires an empty business database; clear old data before migrating';
  END IF;
END $$;
ALTER TABLE "MessageThread" DROP CONSTRAINT "MessageThread_groupId_type_check";
ALTER TABLE "Account" DROP CONSTRAINT "Account_id_fkey";

ALTER TABLE "GroupMetaFeed" DROP CONSTRAINT "GroupMetaFeed_groupId_fkey";

ALTER TABLE "GroupMetaMemberFeed" DROP CONSTRAINT "GroupMetaMemberFeed_memberUserId_fkey";

ALTER TABLE "GroupMetaMemberFeed" DROP CONSTRAINT "GroupMetaMemberFeed_groupId_fkey";

ALTER TABLE "GroupMetaProfileFeed" DROP CONSTRAINT "GroupMetaProfileFeed_groupId_fkey";

ALTER TABLE "GroupRequestProjection" DROP CONSTRAINT "GroupRequestProjection_memberUserId_fkey";

ALTER TABLE "MessageThread" DROP CONSTRAINT "MessageThread_groupId_fkey";

DROP INDEX "GroupMetaMemberFeed_member_feed_idx";
DROP INDEX "GroupMetaMemberFeed_full_sync_idx";
DROP INDEX "MessageThread_groupId_key";
ALTER TABLE "GroupMetaMemberFeed" DROP CONSTRAINT "GroupMetaMemberFeed_pkey";
ALTER TABLE "GroupRequestProjection" DROP CONSTRAINT "GroupRequestProjection_pkey";
ALTER TABLE "GroupMetaFeed" DROP COLUMN "groupId";
ALTER TABLE "GroupMetaMemberFeed" DROP COLUMN "groupId";
ALTER TABLE "GroupMetaMemberFeed" DROP COLUMN "memberUserId";
ALTER TABLE "GroupMetaProfileFeed" DROP COLUMN "groupId";
ALTER TABLE "GroupRequestProjection" DROP COLUMN "memberUserId";
ALTER TABLE "MessageThread" DROP COLUMN "groupId";
DROP TABLE "ProfileVersion";
DROP TABLE "Group";
DROP TABLE "User";
CREATE TABLE "GroupAccount" (
	"id" serial PRIMARY KEY NOT NULL,
	"account" varchar(31) NOT NULL,
	"defaultProfileRev" integer DEFAULT 0 NOT NULL,
	"dissolvedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "GroupAccount_account_key" UNIQUE("account"),
	CONSTRAINT "GroupAccount_account_check" CHECK ("GroupAccount"."account" LIKE '!%'),
	CONSTRAINT "GroupAccount_defaultProfileRev_check" CHECK ("GroupAccount"."defaultProfileRev" >= 0)
);

CREATE TABLE "Profile" (
	"account" varchar(31) NOT NULL,
	"domain" varchar(63) NOT NULL,
	"namespaceId" integer NOT NULL,
	"profileRev" integer NOT NULL,
	"displayName" varchar(30) NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"bio" varchar(255) DEFAULT '' NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "Profile_pkey" PRIMARY KEY("account","domain","namespaceId","profileRev"),
	CONSTRAINT "Profile_profileRev_check" CHECK ("Profile"."profileRev" > 0)
);

ALTER TABLE "Account" ADD COLUMN "account" varchar(31) NOT NULL;
ALTER TABLE "Account" ADD COLUMN "domain" varchar(63) DEFAULT 'local' NOT NULL;
ALTER TABLE "Account" ADD COLUMN "namespaceId" integer DEFAULT 0 NOT NULL;
ALTER TABLE "Account" ADD COLUMN "defaultProfileRev" integer DEFAULT 0 NOT NULL;
ALTER TABLE "Account" ADD COLUMN "availability" varchar(16) DEFAULT 'AVAILABLE' NOT NULL;
ALTER TABLE "GroupMetaFeed" ADD COLUMN "threadId" integer PRIMARY KEY NOT NULL;
ALTER TABLE "GroupMetaMemberFeed" ADD COLUMN "threadId" integer NOT NULL;
ALTER TABLE "GroupMetaMemberFeed" ADD COLUMN "memberAccount" varchar(31) NOT NULL;
ALTER TABLE "GroupMetaMemberFeed" ADD COLUMN "memberDomain" varchar(63) NOT NULL;
ALTER TABLE "GroupMetaMemberFeed" ADD COLUMN "memberNamespaceId" integer NOT NULL;
ALTER TABLE "GroupMetaProfileFeed" ADD COLUMN "threadId" integer PRIMARY KEY NOT NULL;
ALTER TABLE "GroupRequestProjection" ADD COLUMN "memberAccount" varchar(31) NOT NULL;
ALTER TABLE "GroupRequestProjection" ADD COLUMN "memberDomain" varchar(63) NOT NULL;
ALTER TABLE "GroupRequestProjection" ADD COLUMN "memberNamespaceId" integer NOT NULL;
ALTER TABLE "GroupRequestProjection" ADD COLUMN "memberProfileRev" integer NOT NULL;
ALTER TABLE "Message" ADD COLUMN "creatorNamespaceId" integer DEFAULT 0 NOT NULL;
ALTER TABLE "MessageThread" ADD COLUMN "groupAccount" varchar(31);
ALTER TABLE "MessageThread" ADD COLUMN "groupDomain" varchar(63);
ALTER TABLE "MessageThread" ADD COLUMN "groupAccountId" integer;
ALTER TABLE "MessageThread" ADD COLUMN "groupDissolvedAt" timestamp (3) with time zone;
ALTER TABLE "GroupMetaMemberFeed" ADD CONSTRAINT "GroupMetaMemberFeed_pkey" PRIMARY KEY("threadId","feedId");
ALTER TABLE "GroupRequestProjection" ADD CONSTRAINT "GroupRequestProjection_pkey" PRIMARY KEY("managerUserId","threadId","memberAccount","memberDomain","memberNamespaceId","direction");
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "GroupMetaFeed" ADD CONSTRAINT "GroupMetaFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "GroupMetaMemberFeed" ADD CONSTRAINT "GroupMetaMemberFeed_memberNamespaceId_fkey" FOREIGN KEY ("memberNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "GroupMetaMemberFeed" ADD CONSTRAINT "GroupMetaMemberFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "GroupMetaProfileFeed" ADD CONSTRAINT "GroupMetaProfileFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "GroupRequestProjection" ADD CONSTRAINT "GroupRequestProjection_memberNamespaceId_fkey" FOREIGN KEY ("memberNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "Message" ADD CONSTRAINT "Message_creatorNamespaceId_fkey" FOREIGN KEY ("creatorNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_groupAccountId_fkey" FOREIGN KEY ("groupAccountId") REFERENCES "public"."GroupAccount"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "GroupMetaMemberFeed_member_feed_idx" ON "GroupMetaMemberFeed" USING btree ("threadId","memberAccount","memberDomain","memberNamespaceId","feedId");
CREATE INDEX "GroupMetaMemberFeed_full_sync_idx" ON "GroupMetaMemberFeed" USING btree ("threadId","fullSyncRunId","feedId");
CREATE UNIQUE INDEX "MessageThread_group_address_key" ON "MessageThread" USING btree ("groupAccount","groupDomain","authorityNamespaceId");
CREATE UNIQUE INDEX "MessageThread_groupAccountId_key" ON "MessageThread" USING btree ("groupAccountId");
ALTER TABLE "Account" ADD CONSTRAINT "Account_account_key" UNIQUE("account");
ALTER TABLE "Account" ADD CONSTRAINT "Account_local_identity_check" CHECK ("Account"."domain" = 'local' AND "Account"."namespaceId" = 0);
ALTER TABLE "Account" ADD CONSTRAINT "Account_account_check" CHECK ("Account"."account" NOT LIKE '!%');
ALTER TABLE "Account" ADD CONSTRAINT "Account_defaultProfileRev_check" CHECK ("Account"."defaultProfileRev" >= 0);
ALTER TABLE "Account" ADD CONSTRAINT "Account_availability_check" CHECK ("Account"."availability" IN ('AVAILABLE', 'REMOVED'));
ALTER TABLE "Message" ADD CONSTRAINT "Message_creator_namespace_check" CHECK ("Message"."creatorDomain" IS NULL OR (("Message"."creatorDomain" = 'local') = ("Message"."creatorNamespaceId" = 0)));
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_group_type_check" CHECK (("MessageThread"."type" = 'GROUP' AND "MessageThread"."groupAccount" IS NOT NULL AND "MessageThread"."groupDomain" IS NOT NULL) OR ("MessageThread"."type" = 'P2P' AND "MessageThread"."groupAccount" IS NULL AND "MessageThread"."groupDomain" IS NULL AND "MessageThread"."groupAccountId" IS NULL AND "MessageThread"."groupDissolvedAt" IS NULL));
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_group_identity_check" CHECK ("MessageThread"."type" <> 'GROUP' OR (("MessageThread"."groupDomain" = 'local') = ("MessageThread"."authorityNamespaceId" = 0) AND ("MessageThread"."groupDomain" = 'local') = ("MessageThread"."groupAccountId" IS NOT NULL) AND "MessageThread"."groupAccount" LIKE '!%'));
CREATE SEQUENCE "Account_id_seq" OWNED BY "Account".id;
ALTER TABLE "Account" ALTER COLUMN id SET DEFAULT nextval('"Account_id_seq"');
