ALTER TABLE "FederatedPeer"
  ALTER COLUMN "trustLevel" TYPE VARCHAR(31);

COMMENT ON COLUMN "FederatedPeer"."trustLevel" IS
  'Federation trust state, including the reset_in_progress maintenance state.';
