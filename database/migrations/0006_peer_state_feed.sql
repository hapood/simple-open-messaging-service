CREATE TYPE "PeerStateEventType" AS ENUM ('PROFILE', 'P2P_META', 'GROUP_META');

CREATE TABLE "PeerStateFeedTarget" (
  "peerDomain" varchar(63) PRIMARY KEY NOT NULL REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  "allocatedThrough" bigint DEFAULT 0 NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "PeerStateFeedTarget_allocatedThrough_check" CHECK ("allocatedThrough" >= 0)
);

CREATE TABLE "PeerStateFeedPullCursor" (
  "peerDomain" varchar(63) PRIMARY KEY NOT NULL REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  "remoteHwm" bigint DEFAULT 0 NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "PeerStateFeedPullCursor_remoteHwm_check" CHECK ("remoteHwm" >= 0)
);

CREATE TABLE "PeerStateFeed" (
  "peerDomain" varchar(63) NOT NULL REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  "account" varchar(31) NOT NULL,
  "eventType" "PeerStateEventType" NOT NULL,
  "subjectAccount" varchar(31) DEFAULT '' NOT NULL,
  "revision" bigint NOT NULL,
  "rev" bigint NOT NULL,
  "body" jsonb NOT NULL,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "PeerStateFeed_pkey" PRIMARY KEY ("peerDomain", "account", "eventType", "subjectAccount"),
  CONSTRAINT "PeerStateFeed_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "PeerStateFeed_rev_check" CHECK ("rev" > 0),
  CONSTRAINT "PeerStateFeed_subject_check" CHECK (("eventType" = 'P2P_META' AND "subjectAccount" <> '') OR ("eventType" <> 'P2P_META' AND "subjectAccount" = ''))
);

CREATE UNIQUE INDEX "PeerStateFeed_peerDomain_rev_key" ON "PeerStateFeed" ("peerDomain", "rev");
