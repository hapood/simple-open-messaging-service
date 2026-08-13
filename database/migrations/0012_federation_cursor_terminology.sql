ALTER TABLE "PeerStateFeedPullCursor"
  RENAME COLUMN "remoteHwm" TO "committedThrough";

ALTER TABLE "PeerStateFeedPullCursor"
  RENAME CONSTRAINT "PeerStateFeedPullCursor_remoteHwm_check"
  TO "PeerStateFeedPullCursor_committedThrough_check";

ALTER TABLE "FederationPullCursor"
  RENAME COLUMN "remoteHwm" TO "committedThrough";

ALTER TABLE "FederationPullCursor"
  RENAME CONSTRAINT "FederationPullCursor_remoteHwm_check"
  TO "FederationPullCursor_committedThrough_check";

ALTER TABLE "FederationTombstonePullCursor"
  RENAME COLUMN "remoteHwm" TO "committedThrough";

ALTER TABLE "FederationTombstonePullCursor"
  RENAME CONSTRAINT "FederationTombstonePullCursor_remoteHwm_check"
  TO "FederationTombstonePullCursor_committedThrough_check";
