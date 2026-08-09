ALTER TABLE "PeerStateFeed" DROP CONSTRAINT "PeerStateFeed_subject_check";
ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_subject_check" CHECK (
  ("eventType" IN ('P2P_META', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT') AND "subjectAccount" <> '')
  OR ("eventType" IN ('PROFILE', 'GROUP_META') AND "subjectAccount" = '')
);

CREATE TYPE "GroupMembershipDirection" AS ENUM ('INVITE', 'JOIN');
CREATE TYPE "GroupMembershipRequestStatus" AS ENUM ('REQUESTED', 'MEMBER', 'NOT_MEMBER');

CREATE TABLE "GroupMembershipRequest" (
  "groupUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "memberUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  direction "GroupMembershipDirection" NOT NULL,
  status "GroupMembershipRequestStatus" NOT NULL,
  note varchar(255) DEFAULT '' NOT NULL,
  revision integer DEFAULT 0 NOT NULL,
  "requestedAt" timestamp(3),
  "expiresAt" timestamp(3),
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMembershipRequest_pkey" PRIMARY KEY ("groupUserId", "memberUserId", direction),
  CONSTRAINT "GroupMembershipRequest_revision_check" CHECK (revision >= 0 AND "groupUserId" <> "memberUserId")
);

CREATE TABLE "GroupMembershipPair" (
  "groupUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "memberUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  active boolean DEFAULT false NOT NULL,
  role "GroupRole" DEFAULT 'MEMBER' NOT NULL,
  revision integer DEFAULT 0 NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupMembershipPair_pkey" PRIMARY KEY ("groupUserId", "memberUserId"),
  CONSTRAINT "GroupMembershipPair_revision_check" CHECK (revision >= 0)
);

INSERT INTO "GroupMembershipPair" ("groupUserId", "memberUserId", active, role, revision, "updatedAt")
SELECT t."groupUserId", p."userId", p."leftAt" IS NULL, p.role, 1, p."updatedAt"
FROM "MessageThread" t JOIN "ThreadParticipant" p ON p."threadId" = t.id
WHERE t.type = 'GROUP' AND t."groupUserId" IS NOT NULL
ON CONFLICT ("groupUserId", "memberUserId") DO UPDATE SET
  active = EXCLUDED.active, role = EXCLUDED.role,
  revision = GREATEST("GroupMembershipPair".revision, EXCLUDED.revision),
  "updatedAt" = GREATEST("GroupMembershipPair"."updatedAt", EXCLUDED."updatedAt");

INSERT INTO "GroupMembershipRequest" (
  "groupUserId", "memberUserId", direction, status, note, revision, "requestedAt", "expiresAt", "updatedAt"
)
SELECT t."groupUserId", i."toUserId", 'INVITE',
  CASE WHEN i.status = 'PENDING' THEN 'REQUESTED'::"GroupMembershipRequestStatus"
       WHEN i.status = 'ACCEPTED' THEN 'MEMBER'::"GroupMembershipRequestStatus"
       ELSE 'NOT_MEMBER'::"GroupMembershipRequestStatus" END,
  i.note, 1, i."createdAt", i."expiresAt", i."updatedAt"
FROM "Invite" i JOIN "MessageThread" t ON t.id = i."threadId"
WHERE i.kind = 'GROUP' AND t."groupUserId" IS NOT NULL
ON CONFLICT ("groupUserId", "memberUserId", direction) DO UPDATE SET
  status = EXCLUDED.status, note = EXCLUDED.note, "expiresAt" = EXCLUDED."expiresAt",
  "updatedAt" = GREATEST("GroupMembershipRequest"."updatedAt", EXCLUDED."updatedAt");

INSERT INTO "GroupMembershipRequest" (
  "groupUserId", "memberUserId", direction, status, revision, "updatedAt"
)
SELECT "groupUserId", "memberUserId", 'JOIN', 'MEMBER', 1, "updatedAt"
FROM "GroupMembershipPair" WHERE active
ON CONFLICT DO NOTHING;
