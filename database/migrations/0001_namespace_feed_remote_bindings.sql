-- Self bindings are maintained by verified identity exchange, not this feed.
-- Keep the allocator unchanged: removing a compacted item leaves a scan gap.
DELETE FROM "ProfileNamespaceFeed" WHERE "namespaceId" = 0;
ALTER TABLE "ProfileNamespaceFeed"
  ADD CONSTRAINT "ProfileNamespaceFeed_namespace_check" CHECK ("namespaceId" > 0);

-- Repair direct caches from their locally verified authority before removing
-- the old self-binding invalidation path. No remote timestamp is invented.
UPDATE "ProfileNamespace" cache
SET domain = identity.domain,
    "rootPublicKey" = identity."rootPublicKey",
    "sourceGeneratedAt" = 0,
    "updateFeedId" = 0,
    expired = false,
    status = CASE WHEN identity.active AND identity."retiredAt" IS NULL
      THEN 'ACTIVE' ELSE 'ARCHIVED' END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "IdentityNamespace" identity
WHERE cache."publisherNamespaceId" = identity.id
  AND cache."profileNamespaceId" = 0
  AND identity.id > 0
  AND identity."rootPublicKey" IS NOT NULL;
