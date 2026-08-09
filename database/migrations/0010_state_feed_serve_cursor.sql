ALTER TABLE "PeerStateFeedTarget"
  ADD COLUMN "startRev" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "acknowledgedThrough" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "lastServedThrough" bigint DEFAULT 0 NOT NULL,
  ADD CONSTRAINT "PeerStateFeedTarget_cursor_check"
    CHECK ("startRev" >= 0 AND "acknowledgedThrough" >= "startRev"
      AND "lastServedThrough" >= "acknowledgedThrough"
      AND "allocatedThrough" >= "lastServedThrough");
