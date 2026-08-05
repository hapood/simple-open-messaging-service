ALTER TABLE "FederatedPeer"
  ADD CONSTRAINT "FederatedPeer_trustLevel_check"
  CHECK (
    "trustLevel" IN (
      'pending',
      'trusted',
      'demoted',
      'blocked',
      'identity_lost',
      'reset_in_progress'
    )
  );
