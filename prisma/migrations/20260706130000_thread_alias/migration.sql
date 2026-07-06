-- Per-user alias/remark (备注) for a conversation: a nickname the caller gives to a P2P peer or a GROUP,
-- overriding the real name in the caller's chat header + conversation list. Per-user (the peer never sees
-- it). null = use the real name (peer.uniqName / group.name).
ALTER TABLE "ThreadParticipant" ADD COLUMN "alias" VARCHAR(64);
