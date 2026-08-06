ALTER TABLE "FederationPullCursor"
  DROP CONSTRAINT "FederationPullCursor_lastAdvertisedHwm_check",
  DROP COLUMN "lastAdvertisedHwm";
