ALTER TABLE "PeerStateFeedTarget"
  RENAME COLUMN "startRev" TO "retainedAfter";

ALTER TABLE "FederationPullCursor"
  RENAME COLUMN "startChangeId" TO "retainedAfter";

ALTER TABLE "FederationPullCursor"
  RENAME CONSTRAINT "FederationPullCursor_startChangeId_check"
  TO "FederationPullCursor_retainedAfter_check";

ALTER TABLE "FederationServeCursor"
  RENAME COLUMN "startChangeId" TO "retainedAfter";

ALTER TABLE "FederationServeCursor"
  RENAME CONSTRAINT "FederationServeCursor_startChangeId_check"
  TO "FederationServeCursor_retainedAfter_check";

ALTER TABLE "FederationTombstoneServeCursor"
  RENAME COLUMN "startChangeId" TO "retainedAfter";
