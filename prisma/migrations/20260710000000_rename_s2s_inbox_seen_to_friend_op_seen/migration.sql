-- Rename the inbound friend-op dedup table to match its actual role. With the `/inbox` typed bus split
-- into dedicated `/friend-request` + `/friend-approve` routes (the URL is now the discriminator), this
-- table only ever records seen friend ops — so the old ActivityPub "Inbox" name is misleading. The
-- `envelopeId` column becomes `opId` (the friend-op id; an origin-assigned ULID). The rows are
-- transient dedup records; the rename preserves them but they are disposable on a pre-release fleet.
-- Postgres does not auto-rename a PK index/constraint with its table, so the pkey is renamed too.

ALTER TABLE "S2SInboxSeen" RENAME TO "S2SFriendOpSeen";
ALTER TABLE "S2SFriendOpSeen" RENAME COLUMN "envelopeId" TO "opId";
ALTER INDEX "S2SInboxSeen_pkey" RENAME TO "S2SFriendOpSeen_pkey";
