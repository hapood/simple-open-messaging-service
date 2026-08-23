CREATE TABLE "ClientGroupMetaFeedTarget" (
  "userId" integer NOT NULL,
  "groupUserId" integer NOT NULL,
  "allocatedThrough" bigint DEFAULT 0 NOT NULL,
  "oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientGroupMetaFeedTarget_pkey" PRIMARY KEY ("userId", "groupUserId"),
  CONSTRAINT "ClientGroupMetaFeedTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "ClientGroupMetaFeedTarget_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "ClientGroupMetaFeedTarget_allocatedThrough_check" CHECK ("allocatedThrough" >= 0),
  CONSTRAINT "ClientGroupMetaFeedTarget_oldestAvailableAfter_check" CHECK ("oldestAvailableAfter" >= 0 AND "oldestAvailableAfter" <= "allocatedThrough")
);

CREATE TABLE "ClientGroupMetaMemberFeed" (
  "userId" integer NOT NULL,
  "groupUserId" integer NOT NULL,
  "feedId" bigint NOT NULL,
  "memberAccount" varchar(31) NOT NULL,
  "memberDomain" varchar(63) NOT NULL,
  "memberRev" integer NOT NULL,
  operation "GroupMetaMemberOperation" NOT NULL,
  body jsonb NOT NULL,
  "createdAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ClientGroupMetaMemberFeed_pkey" PRIMARY KEY ("userId", "groupUserId", "feedId"),
  CONSTRAINT "ClientGroupMetaMemberFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "ClientGroupMetaMemberFeed_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "ClientGroupMetaMemberFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "ClientGroupMetaMemberFeed_memberRev_check" CHECK ("memberRev" >= 0),
  CONSTRAINT "ClientGroupMetaMemberFeed_body_check" CHECK ((operation = 'UPSERT' AND body <> '{}'::jsonb) OR (operation = 'DELETE' AND body = '{}'::jsonb))
);

CREATE UNIQUE INDEX "ClientGroupMetaMemberFeed_member_rev_key"
  ON "ClientGroupMetaMemberFeed" ("userId", "groupUserId", "memberDomain", "memberAccount", "memberRev");
CREATE INDEX "ClientGroupMetaMemberFeed_member_feed_idx"
  ON "ClientGroupMetaMemberFeed" ("userId", "groupUserId", "memberDomain", "memberAccount", "feedId");
