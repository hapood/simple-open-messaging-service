-- Add Message.originServerTime: the SENDER server's allocation time, copied from the pulled payload's
-- `ts`. The receiver's own `createdAt` (now()) is the local ARRIVAL time (displayed); this column is the
-- origin-faithful time, stored for future use (quota/audit) and never displayed. Nullable: null for
-- locally-authored messages and legacy rows. No backfill.
ALTER TABLE "Message" ADD COLUMN "originServerTime" TIMESTAMP(3);
