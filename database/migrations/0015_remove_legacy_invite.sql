ALTER TABLE "FriendRequest"
  ADD COLUMN id bigserial NOT NULL,
  ADD COLUMN "expiresAt" timestamp(3);
CREATE UNIQUE INDEX "FriendRequest_id_key" ON "FriendRequest" (id);

ALTER TABLE "GroupMembershipRequest"
  ADD COLUMN id bigserial NOT NULL;
CREATE UNIQUE INDEX "GroupMembershipRequest_id_key" ON "GroupMembershipRequest" (id);

-- Capture any request rows written after the earlier fact-table backfills but before this deployment.
INSERT INTO "FriendRequest" (
  "requesterUserId", "targetUserId", status, note, revision,
  "requestedAt", "expiresAt", "updatedAt"
)
SELECT DISTINCT ON (i."fromUserId", i."toUserId")
  i."fromUserId", i."toUserId",
  CASE WHEN i.status = 'PENDING' THEN 'REQUESTED'::"FriendRequestStatus"
       WHEN i.status = 'ACCEPTED' THEN 'FRIEND'::"FriendRequestStatus"
       ELSE 'NOT_FRIEND'::"FriendRequestStatus" END,
  i.note, 1, i."createdAt", i."expiresAt", i."updatedAt"
FROM "Invite" i
WHERE i.kind = 'FRIEND'
ORDER BY i."fromUserId", i."toUserId", i."updatedAt" DESC, i.id DESC
ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
  status = EXCLUDED.status,
  note = EXCLUDED.note,
  "requestedAt" = EXCLUDED."requestedAt",
  "expiresAt" = EXCLUDED."expiresAt",
  "updatedAt" = GREATEST("FriendRequest"."updatedAt", EXCLUDED."updatedAt");

INSERT INTO "GroupMembershipRequest" (
  "groupUserId", "memberUserId", direction, status, note, revision,
  "requestedAt", "expiresAt", "updatedAt"
)
SELECT DISTINCT ON (t."groupUserId", i."toUserId")
  t."groupUserId", i."toUserId", 'INVITE',
  CASE WHEN i.status = 'PENDING' THEN 'REQUESTED'::"GroupMembershipRequestStatus"
       WHEN i.status = 'ACCEPTED' THEN 'MEMBER'::"GroupMembershipRequestStatus"
       ELSE 'NOT_MEMBER'::"GroupMembershipRequestStatus" END,
  i.note, 1, i."createdAt", i."expiresAt", i."updatedAt"
FROM "Invite" i
JOIN "MessageThread" t ON t.id = i."threadId"
WHERE i.kind = 'GROUP' AND t."groupUserId" IS NOT NULL
ORDER BY t."groupUserId", i."toUserId", i."updatedAt" DESC, i.id DESC
ON CONFLICT ("groupUserId", "memberUserId", direction) DO UPDATE SET
  status = EXCLUDED.status,
  note = EXCLUDED.note,
  "requestedAt" = EXCLUDED."requestedAt",
  "expiresAt" = EXCLUDED."expiresAt",
  "updatedAt" = GREATEST("GroupMembershipRequest"."updatedAt", EXCLUDED."updatedAt");

DROP TABLE "Invite";
DROP TYPE "InviteKind";
DROP TYPE "InviteStatus";

-- Command-style friend operations no longer exist; state-feed revision gating is the deduplicator.
DROP TABLE "S2SFriendOpSeen";
