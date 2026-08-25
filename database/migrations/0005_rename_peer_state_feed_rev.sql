ALTER TABLE "PeerStateFeed"
  RENAME COLUMN rev TO "feedId";

ALTER INDEX "PeerStateFeed_peerDomain_rev_key"
  RENAME TO "PeerStateFeed_peerDomain_feedId_key";

ALTER TABLE "PeerStateFeed"
  RENAME CONSTRAINT "PeerStateFeed_rev_check" TO "PeerStateFeed_feedId_check";
