ALTER TABLE "LocalFederationIdentity"
  DROP CONSTRAINT IF EXISTS "LocalFederationIdentity_identityEpoch_check";

ALTER TABLE "LocalFederationIdentity"
  DROP COLUMN IF EXISTS "identityEpoch";

ALTER TABLE "FederatedPeer"
  DROP CONSTRAINT IF EXISTS "FederatedPeer_identityEpoch_check";

ALTER TABLE "FederatedPeer"
  DROP COLUMN IF EXISTS "identityEpoch";
