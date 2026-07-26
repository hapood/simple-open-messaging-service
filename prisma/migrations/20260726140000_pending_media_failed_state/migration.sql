-- Complete the local media staging state machine:
-- pending -> failed -> pending (explicit retry), with a bounded diagnostic reason.
ALTER TABLE "PendingMedia" ADD COLUMN "failReason" VARCHAR(255);
