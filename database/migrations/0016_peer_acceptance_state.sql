ALTER TABLE "FederatedPeer"
  ADD COLUMN "peerAcceptanceConfirmed" boolean NOT NULL DEFAULT false;

ALTER TABLE "FederatedPeer"
  DROP COLUMN "outboundRecognitionConfirmed",
  DROP COLUMN "inboundRecognitionConfirmed",
  DROP COLUMN "lightweightInboundReady",
  DROP COLUMN "reverseRecognitionPending",
  DROP COLUMN "outboundRecognizedAt",
  DROP COLUMN "inboundRecognizedAt";

UPDATE "FederatedPeer"
SET "trustLevel" = CASE
  WHEN "activeNamespaceId" IS NOT NULL
    AND "recognizesPeer"
    AND "localServiceAvailable" THEN 'establishing'
  ELSE 'unrecognized'
END
WHERE "trustLevel" IN ('available', 'degraded');
