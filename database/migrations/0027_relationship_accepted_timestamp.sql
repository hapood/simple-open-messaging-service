UPDATE "RelationshipIntent"
SET "requestedAt" = "updatedAt"
WHERE status = 'ACCEPTED' AND "requestedAt" IS NULL;

UPDATE "FederatedFriendRequest"
SET "requestedAt" = "updatedAt"
WHERE status = 'ACCEPTED' AND "requestedAt" IS NULL;

ALTER TABLE "RelationshipIntent"
  DROP CONSTRAINT "FriendRequest_expiry_check",
  ADD CONSTRAINT "RelationshipIntent_expiry_check" CHECK (
    (status = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt"
      AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR (status = 'ACCEPTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NULL)
    OR (status = 'REVOKED' AND "expiresAt" IS NULL)
  );

ALTER TABLE "FederatedFriendRequest"
  DROP CONSTRAINT "FederatedFriendRequest_expiry_check",
  ADD CONSTRAINT "FederatedFriendRequest_expiry_check" CHECK (
    (status = 'REQUESTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "expiresAt" > "requestedAt"
      AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
    OR (status = 'ACCEPTED' AND "requestedAt" IS NOT NULL AND "expiresAt" IS NULL)
    OR (status = 'REVOKED' AND "expiresAt" IS NULL)
  );
