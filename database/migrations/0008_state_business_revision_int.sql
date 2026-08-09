ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "revision" TYPE integer
  USING "revision"::integer;
