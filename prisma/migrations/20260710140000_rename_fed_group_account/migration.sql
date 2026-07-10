-- Rename MessageThread.federatedThreadId → fedGroupAccount: the column holds the group's `!account`
-- (a ULID), the cross-server identity + on-wire group address — NOT a thread id. The old name + its
-- stale comment described an abandoned "thr_<rand>@<domain>" design. Pure rename, no data change.
ALTER TABLE "MessageThread" RENAME COLUMN "federatedThreadId" TO "fedGroupAccount";
