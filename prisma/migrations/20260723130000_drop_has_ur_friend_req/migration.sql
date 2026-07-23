-- Drop the denormalized `hasUrFriendReq` boolean. The friend-request badge is now derived from the
-- Invite data itself: the client compares the SSE HELLO/push-carried `friendReqRev` (= MAX(updatedAt) over
-- the user's incoming FRIEND invites — a monotonic, data-derived revision) to its IDB cursor, mirroring the
-- threadRevision delta model. No denormalized badge column to keep in sync; accept/decline/expiry advance
-- the derived revision automatically via the rows' own `updatedAt`.
ALTER TABLE "User" DROP COLUMN "hasUrFriendReq";
