-- Remove indexes whose leading columns are already covered by another B-tree:
--   ThreadParticipant(userId)               -> unique(userId, threadId)
--   MessageThread(groupUserId)               -> unique(groupUserId)
--   Message(threadId, creator, originSeq)     -> unique(threadId, creator, originSeq)
--   S2SKeyCache(domain)                       -> primary key(domain, keyId)
--
-- PostgreSQL can use a composite B-tree for predicates on its leftmost columns,
-- so retaining both copies only adds storage and write amplification.
DROP INDEX "ThreadParticipant_userId_idx";
DROP INDEX "MessageThread_groupUserId_idx";
DROP INDEX "Message_threadId_creator_originSeq_idx";
DROP INDEX "S2SKeyCache_domain_idx";

-- Active session/device list for one user. The query filters revokedAt IS NULL,
-- applies the expiry predicate, and orders by lastSeenAt DESC.
CREATE INDEX "SessionToken_userId_lastSeenAt_active_idx"
ON "SessionToken" ("userId", "lastSeenAt" DESC)
WHERE "revokedAt" IS NULL;

-- Admin session list + dashboard active-session count. Keeping only active
-- rows makes this substantially smaller when revoked session history grows.
CREATE INDEX "SessionToken_lastSeenAt_active_idx"
ON "SessionToken" ("lastSeenAt" DESC)
WHERE "revokedAt" IS NULL;

-- Friend request panels always read pending FRIEND rows for one endpoint user,
-- newest first. These indexes also satisfy the createdAt range predicate.
CREATE INDEX "Invite_incoming_friend_pending_createdAt_idx"
ON "Invite" ("toUserId", "createdAt" DESC)
WHERE "kind" = 'FRIEND' AND "status" = 'PENDING';

CREATE INDEX "Invite_outgoing_friend_pending_createdAt_idx"
ON "Invite" ("fromUserId", "createdAt" DESC)
WHERE "kind" = 'FRIEND' AND "status" = 'PENDING';

-- Fan-out, roster reads, and active-member counts all exclude soft-left rows;
-- joinedAt supplies the roster ordering without a separate sort.
CREATE INDEX "ThreadParticipant_threadId_joinedAt_active_idx"
ON "ThreadParticipant" ("threadId", "joinedAt")
WHERE "leftAt" IS NULL;
