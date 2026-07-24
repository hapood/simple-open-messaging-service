-- Friend-request read cursor. The client derives the unread badge as friendReqRev (MAX(updatedAt) over
-- incoming FRIEND invites, SSE-carried) > friendReqAckRev; markRead advances this, clearing the badge on
-- all devices (server-state, multi-device consistent). TIMESTAMP(3) = same type as the derivation (no
-- 2038/overflow). Default epoch = "never acked" (existing unread requests show the badge until markRead).
-- The wire carries both as epoch-ms (JS Number); only the durable column is a Date.
ALTER TABLE "User" ADD COLUMN "friendReqAckRev" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00';
