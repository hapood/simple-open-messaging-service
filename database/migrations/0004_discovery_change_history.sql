-- Revoking current thread access must not erase proof that a message was already allocated to a peer.
-- Historical DiscoveryChange rows authorize interrupted CAS/bundle downloads after an unfriend/leave.
ALTER TABLE "DiscoveryChange"
  DROP CONSTRAINT "DiscoveryChange_audienceId_fkey";

ALTER TABLE "DiscoveryChange"
  ALTER COLUMN "audienceId" DROP NOT NULL,
  ADD CONSTRAINT "DiscoveryChange_audienceId_fkey"
    FOREIGN KEY ("audienceId") REFERENCES "ThreadAudience"("id") ON DELETE SET NULL;
