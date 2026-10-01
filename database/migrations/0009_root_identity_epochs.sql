-- Root-identity model (spec v1 redesign): root epochs with permanently retained
-- key history, fingerprints removed, identity reviews replace namespace candidates.
-- The protocol is rc.0 and was never published; identity rows are migrated
-- destructively where the old shape cannot represent the new model.

-- Local root epochs: replaces LocalFederationIdentity. Existing deployments carry
-- at most one identity epoch; it becomes the single claimable root with a long
-- default validity. Private material is retained forever so sealed challenges
-- under retired roots stay openable.
CREATE TABLE public."LocalFederationRoot" (
  "id" serial PRIMARY KEY NOT NULL,
  "domain" varchar(63) NOT NULL,
  "rootPublicKey" varchar(44) NOT NULL,
  "rootPrivateKey" varchar(44) NOT NULL,
  "notBefore" timestamp(3) with time zone NOT NULL,
  "notAfter" timestamp(3) with time zone NOT NULL,
  "claimable" boolean DEFAULT false NOT NULL,
  "unpublishedAt" timestamp(3) with time zone,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "LocalFederationRoot_rootPublicKey_key" UNIQUE ("rootPublicKey")
);

CREATE UNIQUE INDEX "LocalFederationRoot_one_claimable_key"
  ON public."LocalFederationRoot" ("domain") WHERE "claimable" = true;

ALTER TABLE public."LocalFederationRoot"
  ADD CONSTRAINT "LocalFederationRoot_validity_check"
    CHECK ("notBefore" < "notAfter"),
  ADD CONSTRAINT "LocalFederationRoot_claimable_check"
    CHECK ("claimable" = false OR "unpublishedAt" IS NULL);

INSERT INTO public."LocalFederationRoot"
  ("domain", "rootPublicKey", "rootPrivateKey", "notBefore", "notAfter", "claimable")
SELECT "domain", "rootPublicKey", "rootPrivateKey", "createdAt",
       "createdAt" + interval '3650 days', true
FROM public."LocalFederationIdentity";

-- Signing keys: permanently retained (private material included) and linked to
-- their authorizing root epoch. keyId becomes globally unique and permanently
-- bound to one public key.
-- Column defaults cannot contain subqueries: add nullable, backfill from
-- the just-inserted first root epoch, then pin NOT NULL and the FK.
ALTER TABLE public."LocalFederationSigningKey"
  ADD COLUMN "rootId" integer;

UPDATE public."LocalFederationSigningKey"
SET "rootId" = (SELECT "id" FROM public."LocalFederationRoot" ORDER BY "id" LIMIT 1)
WHERE "rootId" IS NULL;

ALTER TABLE public."LocalFederationSigningKey"
  ALTER COLUMN "rootId" SET NOT NULL,
  ADD CONSTRAINT "LocalFederationSigningKey_root_fkey" FOREIGN KEY ("rootId")
    REFERENCES public."LocalFederationRoot" ("id") ON DELETE RESTRICT;

-- Dependent state FKs must drop before the key table's primary key can.
ALTER TABLE public."LocalFederationSigningState"
  DROP CONSTRAINT "LocalFederationSigningState_identity_fkey",
  DROP CONSTRAINT "LocalFederationSigningState_current_key_fkey",
  DROP CONSTRAINT "LocalFederationSigningState_successor_key_fkey";

ALTER TABLE public."LocalFederationSigningKey" DROP CONSTRAINT "LocalFederationSigningKey_pkey";
ALTER TABLE public."LocalFederationSigningKey" DROP CONSTRAINT "LocalFederationSigningKey_identity_fkey";
ALTER TABLE public."LocalFederationSigningKey" DROP COLUMN "domain";
ALTER TABLE public."LocalFederationSigningKey"
  ADD CONSTRAINT "LocalFederationSigningKey_pkey" PRIMARY KEY ("keyId");

ALTER TABLE public."LocalFederationSigningState"
  ADD CONSTRAINT "LocalFederationSigningState_current_key_fkey"
    FOREIGN KEY ("currentKeyId") REFERENCES public."LocalFederationSigningKey" ("keyId") ON DELETE RESTRICT,
  ADD CONSTRAINT "LocalFederationSigningState_successor_key_fkey"
    FOREIGN KEY ("plannedSuccessorKeyId") REFERENCES public."LocalFederationSigningKey" ("keyId") ON DELETE SET NULL;

DROP TABLE public."LocalFederationIdentity";

-- Peer identity epochs: identity is the pinned root public key itself; the
-- fingerprint column is removed. One live epoch per root public key.
ALTER TABLE public."IdentityNamespace" DROP COLUMN "rootKeyFingerprint";

ALTER TABLE public."IdentityNamespace"
  DROP CONSTRAINT IF EXISTS "IdentityNamespace_shape_check";

ALTER TABLE public."IdentityNamespace"
  ADD CONSTRAINT "IdentityNamespace_shape_check" CHECK ((
    "id" = 0
    AND "domain" = 'local'
    AND "rootPublicKey" IS NULL
    AND "identityPinnedAt" IS NULL
    AND "peerAssignedLocalNamespaceId" IS NULL
    AND "retiredAt" IS NULL
    AND "active" = false
    AND "trustLevel" = 'unrecognized'
    AND "trustedAt" IS NULL
    AND "lastSuccessAt" IS NULL
    AND "degradedAt" IS NULL
    AND "degradationReason" IS NULL
    AND "degradationCount" = 0
    AND "haltedAt" IS NULL
    AND "haltCode" IS NULL
    AND "haltReason" IS NULL
    AND "recognizesPeer" = false
    AND "peerAcceptanceConfirmed" = false
    AND "localServiceAvailable" = false
    AND "remoteServiceReachable" = false
    AND "resetAt" IS NULL
  ) OR (
    "id" > 0
    AND "domain" <> 'local'
    AND "rootPublicKey" IS NOT NULL
    AND "identityPinnedAt" IS NOT NULL
    AND ("peerAssignedLocalNamespaceId" IS NULL OR "peerAssignedLocalNamespaceId" > 0)
  ));

CREATE UNIQUE INDEX "IdentityNamespace_one_epoch_per_root_key"
  ON public."IdentityNamespace" ("rootPublicKey")
  WHERE "id" > 0 AND "retiredAt" IS NULL AND "rootPublicKey" IS NOT NULL;

-- Cached certificates now record their authorizing root; the cache is
-- disposable and is rebuilt from well-known on the next fetch.
DELETE FROM public."S2SKeyCache";

ALTER TABLE public."S2SKeyCache" ADD COLUMN "root" varchar(44) NOT NULL DEFAULT '';

-- Identity reviews replace namespace candidates; open candidates on lab
-- databases are dropped (rc.0 data model).
DROP TABLE public."FederationNamespaceCandidate";

CREATE TABLE public."FederationIdentityReview" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" varchar(15) NOT NULL,
  "matchedNamespaceId" integer NOT NULL,
  "nextDomain" varchar(63) NOT NULL,
  "claimedRoot" varchar(44) NOT NULL,
  "claim" jsonb NOT NULL,
  "status" varchar(15) DEFAULT 'pending' NOT NULL,
  "reviewedAt" timestamp(3) with time zone,
  "verifiedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "FederationIdentityReview_matchedNamespace_fkey" FOREIGN KEY ("matchedNamespaceId")
    REFERENCES public."IdentityNamespace" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "FederationIdentityReview_one_pending_per_namespace_key"
  ON public."FederationIdentityReview" ("matchedNamespaceId") WHERE "status" = 'pending';

ALTER TABLE public."FederationIdentityReview"
  ADD CONSTRAINT "FederationIdentityReview_matchedNamespace_check"
    CHECK ("matchedNamespaceId" > 0),
  ADD CONSTRAINT "FederationIdentityReview_kind_check"
    CHECK ("kind" IN ('domain-rebind', 'root-rotation')),
  ADD CONSTRAINT "FederationIdentityReview_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected')),
  ADD CONSTRAINT "FederationIdentityReview_reviewed_check"
    CHECK (("status" = 'pending') = ("reviewedAt" IS NULL));
