-- Keep the peer-authoritative group roster separate from the local conversation projection.
-- Group-meta delta pages update this table and only then derive ThreadParticipant rows.
CREATE TABLE "FederatedGroupMember" (
  "sourcePeerDomain" varchar(63) NOT NULL,
  "groupAccount" varchar(31) NOT NULL,
  "memberAccount" varchar(31) NOT NULL,
  "memberDomain" varchar(63) NOT NULL,
  "memberRev" integer NOT NULL,
  role "GroupRole" NOT NULL,
  "seenAtFeedId" bigint NOT NULL,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederatedGroupMember_pkey" PRIMARY KEY (
    "sourcePeerDomain", "groupAccount", "memberAccount", "memberDomain"
  ),
  CONSTRAINT "FederatedGroupMember_sourcePeerDomain_fkey"
    FOREIGN KEY ("sourcePeerDomain") REFERENCES "FederatedPeer"(domain) ON DELETE CASCADE,
  CONSTRAINT "FederatedGroupMember_groupAccount_check" CHECK ("groupAccount" LIKE '!%'),
  CONSTRAINT "FederatedGroupMember_memberRev_check" CHECK ("memberRev" >= 0),
  CONSTRAINT "FederatedGroupMember_seenAtFeedId_check" CHECK ("seenAtFeedId" >= 0)
);

CREATE INDEX "FederatedGroupMember_group_idx"
  ON "FederatedGroupMember" ("sourcePeerDomain", "groupAccount");
