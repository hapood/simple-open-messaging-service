ALTER TABLE "IdentityNamespace"
  ADD COLUMN "peerAssignedLocalNamespaceId" integer;

ALTER TABLE "IdentityNamespace"
  DROP CONSTRAINT "IdentityNamespace_shape_check";

ALTER TABLE "IdentityNamespace"
  ADD CONSTRAINT "IdentityNamespace_shape_check"
  CHECK (
    (
      id = 0
      AND domain = 'local'
      AND "rootKeyFingerprint" IS NULL
      AND "rootPublicKey" IS NULL
      AND "identityPinnedAt" IS NULL
      AND "peerAssignedLocalNamespaceId" IS NULL
      AND "retiredAt" IS NULL
    ) OR (
      id > 0
      AND domain <> 'local'
      AND "rootKeyFingerprint" IS NOT NULL
      AND "rootPublicKey" IS NOT NULL
      AND "identityPinnedAt" IS NOT NULL
      AND ("peerAssignedLocalNamespaceId" IS NULL OR "peerAssignedLocalNamespaceId" > 0)
    )
  );
