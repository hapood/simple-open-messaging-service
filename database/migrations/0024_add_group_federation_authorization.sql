ALTER TABLE "Group"
  ADD COLUMN "federationAuthorized" boolean NOT NULL DEFAULT false;

UPDATE "Group" group_profile
SET "federationAuthorized" = true
WHERE group_profile.domain <> 'local'
  AND EXISTS (
    SELECT 1
    FROM "RelationshipPair" pair
    WHERE pair.kind = 'GROUP_MEMBER'
      AND pair.active = true
      AND (
        (pair."endpointAType" = 'GROUP'
          AND pair."endpointAAccount" = group_profile.account
          AND pair."endpointADomain" = group_profile.domain
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBDomain" = 'local')
        OR
        (pair."endpointBType" = 'GROUP'
          AND pair."endpointBAccount" = group_profile.account
          AND pair."endpointBDomain" = group_profile.domain
          AND pair."endpointAType" = 'USER'
          AND pair."endpointADomain" = 'local')
      )
  );

ALTER TABLE "Group"
  ADD CONSTRAINT "Group_local_federationAuthorized_check"
  CHECK (domain <> 'local' OR "federationAuthorized" = false);
