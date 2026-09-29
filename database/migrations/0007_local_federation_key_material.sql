-- Local federation key material moves from data/soms-s2s-key.json into the database.
-- Private keys are stored unencrypted; database access control is the secret boundary.
-- There is no compatibility path from the old key file: file-era LocalFederationIdentity
-- rows hold only a fingerprint anchor (their private material never existed in the
-- database), so they are removed and the deployment generates a fresh database-backed
-- identity on first boot.
ALTER TABLE public."LocalFederationIdentity"
  ADD COLUMN "rootPublicKey" varchar(44),
  ADD COLUMN "rootPrivateKey" varchar(44);

DELETE FROM public."LocalFederationIdentity";

ALTER TABLE public."LocalFederationIdentity"
  ALTER COLUMN "rootPublicKey" SET NOT NULL,
  ALTER COLUMN "rootPrivateKey" SET NOT NULL;

-- Per-certificate signing keys under the root identity. Rows past their notAfter are
-- removed together with their private material by the local lifecycle maintainer.
CREATE TABLE public."LocalFederationSigningKey" (
  "domain" varchar(63) NOT NULL,
  "keyId" varchar(127) NOT NULL,
  "publicKey" varchar(44) NOT NULL,
  "privateKey" varchar(44) NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "notBefore" timestamp(3) with time zone NOT NULL,
  "notAfter" timestamp(3) with time zone NOT NULL,
  CONSTRAINT "LocalFederationSigningKey_pkey" PRIMARY KEY ("domain", "keyId"),
  CONSTRAINT "LocalFederationSigningKey_identity_fkey" FOREIGN KEY ("domain")
    REFERENCES public."LocalFederationIdentity" ("domain") ON DELETE CASCADE,
  CONSTRAINT "LocalFederationSigningKey_validity_check"
    CHECK ("notBefore" < "notAfter")
);

-- Single-row-per-domain signing selection: exactly one key signs new outbound requests
-- at any instant; the planned switch is applied atomically.
CREATE TABLE public."LocalFederationSigningState" (
  "domain" varchar(63) NOT NULL,
  "currentKeyId" varchar(127) NOT NULL,
  "plannedSwitchAt" timestamp(3) with time zone,
  "plannedSuccessorKeyId" varchar(127),
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "LocalFederationSigningState_pkey" PRIMARY KEY ("domain"),
  CONSTRAINT "LocalFederationSigningState_identity_fkey" FOREIGN KEY ("domain")
    REFERENCES public."LocalFederationIdentity" ("domain") ON DELETE CASCADE,
  CONSTRAINT "LocalFederationSigningState_current_key_fkey"
    FOREIGN KEY ("domain", "currentKeyId")
    REFERENCES public."LocalFederationSigningKey" ("domain", "keyId") ON DELETE RESTRICT,
  CONSTRAINT "LocalFederationSigningState_successor_key_fkey"
    FOREIGN KEY ("domain", "plannedSuccessorKeyId")
    REFERENCES public."LocalFederationSigningKey" ("domain", "keyId") ON DELETE SET NULL,
  CONSTRAINT "LocalFederationSigningState_plan_check"
    CHECK (("plannedSwitchAt" IS NULL) = ("plannedSuccessorKeyId" IS NULL))
);
