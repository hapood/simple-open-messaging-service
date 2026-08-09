CREATE TYPE "FriendRequestStatus" AS ENUM ('REQUESTED', 'FRIEND', 'NOT_FRIEND');

CREATE TABLE "FriendRequest" (
  "requesterUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "targetUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "status" "FriendRequestStatus" NOT NULL,
  "note" varchar(255) DEFAULT '' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "requestedAt" timestamp(3),
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "FriendRequest_pkey" PRIMARY KEY ("requesterUserId", "targetUserId"),
  CONSTRAINT "FriendRequest_revision_check"
    CHECK ("revision" >= 0 AND "requesterUserId" <> "targetUserId")
);

CREATE TABLE "FriendPair" (
  "userLowId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "userHighId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "threadId" integer REFERENCES "MessageThread"("id") ON DELETE SET NULL,
  "active" boolean DEFAULT false NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "FriendPair_pkey" PRIMARY KEY ("userLowId", "userHighId"),
  CONSTRAINT "FriendPair_order_check" CHECK ("userLowId" < "userHighId"),
  CONSTRAINT "FriendPair_revision_check" CHECK ("revision" >= 0)
);

INSERT INTO "FriendRequest" (
  "requesterUserId", "targetUserId", "status", "note", "revision", "requestedAt", "updatedAt"
)
SELECT DISTINCT ON (i."fromUserId", i."toUserId")
  i."fromUserId", i."toUserId",
  CASE WHEN i.status = 'PENDING' THEN 'REQUESTED'::"FriendRequestStatus"
       WHEN i.status = 'ACCEPTED' THEN 'FRIEND'::"FriendRequestStatus"
       ELSE 'NOT_FRIEND'::"FriendRequestStatus" END,
  i.note, 1, i."createdAt", i."updatedAt"
FROM "Invite" i
WHERE i.kind = 'FRIEND'
ORDER BY i."fromUserId", i."toUserId", i."updatedAt" DESC, i.id DESC;

INSERT INTO "FriendRequest" (
  "requesterUserId", "targetUserId", "status", "note", "revision", "requestedAt", "updatedAt"
)
SELECT p."userId", peer."userId", 'FRIEND', '', GREATEST(p."relationshipRev", 1), NULL,
       GREATEST(p."updatedAt", peer."updatedAt")
FROM "ThreadParticipant" p
JOIN "MessageThread" t ON t.id = p."threadId" AND t.type = 'P2P'
JOIN "ThreadParticipant" peer ON peer."threadId" = t.id AND peer.id <> p.id
WHERE p."leftAt" IS NULL AND peer."leftAt" IS NULL
ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
  status = 'FRIEND', revision = GREATEST("FriendRequest".revision, EXCLUDED.revision),
  "updatedAt" = GREATEST("FriendRequest"."updatedAt", EXCLUDED."updatedAt");

INSERT INTO "FriendPair" ("userLowId", "userHighId", "threadId", active, revision, "updatedAt")
SELECT DISTINCT ON (LEAST(a."userId", b."userId"), GREATEST(a."userId", b."userId"))
  LEAST(a."userId", b."userId"), GREATEST(a."userId", b."userId"), t.id,
  a."leftAt" IS NULL AND b."leftAt" IS NULL, 1, GREATEST(a."updatedAt", b."updatedAt")
FROM "MessageThread" t
JOIN "ThreadParticipant" a ON a."threadId" = t.id
JOIN "ThreadParticipant" b ON b."threadId" = t.id AND a.id < b.id
WHERE t.type = 'P2P'
ORDER BY LEAST(a."userId", b."userId"), GREATEST(a."userId", b."userId"),
         (a."leftAt" IS NULL AND b."leftAt" IS NULL) DESC, t.id DESC;
