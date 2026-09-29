CREATE TABLE "FederationNamespaceCandidate" (
  "nextDomain" varchar(63) PRIMARY KEY NOT NULL,
  "matchedNamespaceId" integer,
  "rootKeyFingerprint" varchar(80) NOT NULL,
  "rootPublicKey" varchar(44) NOT NULL,
  "peerAssignedLocalNamespaceId" integer,
  "status" varchar(15) DEFAULT 'pending' NOT NULL,
  "failedCode" integer,
  "failedMessage" text,
  "verifiedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "FederationNamespaceCandidate_matchedNamespace_fkey"
    FOREIGN KEY ("matchedNamespaceId") REFERENCES "IdentityNamespace"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationNamespaceCandidate_matchedNamespace_check"
    CHECK ("matchedNamespaceId" IS NULL OR "matchedNamespaceId" > 0),
  CONSTRAINT "FederationNamespaceCandidate_peerAssignedLocalNamespace_check"
    CHECK ("peerAssignedLocalNamespaceId" IS NULL OR "peerAssignedLocalNamespaceId" > 0),
  CONSTRAINT "FederationNamespaceCandidate_status_check"
    CHECK ("status" IN ('pending', 'failed')),
  CONSTRAINT "FederationNamespaceCandidate_failed_check"
    CHECK (("status" = 'failed') = ("failedCode" IS NOT NULL AND "failedMessage" IS NOT NULL))
);

CREATE UNIQUE INDEX "FederationNamespaceCandidate_matchedNamespace_key"
  ON "FederationNamespaceCandidate" ("matchedNamespaceId")
  WHERE "matchedNamespaceId" IS NOT NULL;

ALTER TABLE "FederatedPeer" DROP CONSTRAINT "FederatedPeer_trustLevel_check";
ALTER TABLE "FederatedPeer"
  ADD CONSTRAINT "FederatedPeer_trustLevel_check"
  CHECK (("trustLevel")::text = ANY (ARRAY[
    ('unrecognized'::character varying)::text,
    ('establishing'::character varying)::text,
    ('pending'::character varying)::text,
    ('available'::character varying)::text,
    ('degraded'::character varying)::text,
    ('halted'::character varying)::text
  ]));
