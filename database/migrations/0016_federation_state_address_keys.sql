ALTER TABLE "PeerStateFeed"
  ADD COLUMN "domain" VARCHAR(63),
  ADD COLUMN "subjectDomain" VARCHAR(63) NOT NULL DEFAULT '';

ALTER TABLE "PeerStateFeedVersion"
  ADD COLUMN "domain" VARCHAR(63),
  ADD COLUMN "subjectDomain" VARCHAR(63) NOT NULL DEFAULT '';

UPDATE "PeerStateFeed" item SET
  "domain" = CASE item."eventType"::text
    WHEN 'PROFILE' THEN COALESCE(item.body->>'domain', (SELECT domain FROM "LocalFederationIdentity" LIMIT 1))
    WHEN 'P2P_INTENT' THEN (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
    WHEN 'GROUP_INVITE_INTENT' THEN (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
    WHEN 'GROUP_JOIN_INTENT' THEN item."peerDomain"
    WHEN 'GROUP_META' THEN (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
    ELSE (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
  END,
  "subjectDomain" = CASE item."eventType"::text
    WHEN 'P2P_INTENT' THEN item."peerDomain"
    WHEN 'GROUP_INVITE_INTENT' THEN item."peerDomain"
    WHEN 'GROUP_JOIN_INTENT' THEN COALESCE((SELECT domain FROM "LocalFederationIdentity" LIMIT 1), '')
    ELSE ''
  END,
  body = CASE WHEN item."eventType"::text = 'PROFILE' THEN
    jsonb_build_object(
      'displayName', item.body->>'name',
      'bio', COALESCE(item.body->>'bio', ''),
      'avatar', NULL,
      'deleted', COALESCE((item.body->>'deleted')::boolean, false)
    )
  ELSE item.body END;

UPDATE "PeerStateFeedVersion" item SET
  "domain" = CASE item."eventType"::text
    WHEN 'PROFILE' THEN COALESCE(item.body->>'domain', (SELECT domain FROM "LocalFederationIdentity" LIMIT 1))
    WHEN 'P2P_INTENT' THEN (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
    WHEN 'GROUP_INVITE_INTENT' THEN (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
    WHEN 'GROUP_JOIN_INTENT' THEN item."peerDomain"
    WHEN 'GROUP_META' THEN (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
    ELSE (SELECT domain FROM "LocalFederationIdentity" LIMIT 1)
  END,
  "subjectDomain" = CASE item."eventType"::text
    WHEN 'P2P_INTENT' THEN item."peerDomain"
    WHEN 'GROUP_INVITE_INTENT' THEN item."peerDomain"
    WHEN 'GROUP_JOIN_INTENT' THEN COALESCE((SELECT domain FROM "LocalFederationIdentity" LIMIT 1), '')
    ELSE ''
  END,
  body = CASE WHEN item."eventType"::text = 'PROFILE' THEN
    jsonb_build_object(
      'displayName', item.body->>'name',
      'bio', COALESCE(item.body->>'bio', ''),
      'avatar', NULL,
      'deleted', COALESCE((item.body->>'deleted')::boolean, false)
    )
  ELSE item.body END;

-- A pristine database may not yet have a LocalFederationIdentity row. Such a database cannot have
-- meaningful state-feed items, but keep migration deterministic if test fixtures inserted them.
UPDATE "PeerStateFeed" SET "domain" = "peerDomain" WHERE "domain" IS NULL;
UPDATE "PeerStateFeedVersion" SET "domain" = "peerDomain" WHERE "domain" IS NULL;

ALTER TABLE "PeerStateFeed" ALTER COLUMN "domain" SET NOT NULL;
ALTER TABLE "PeerStateFeedVersion" ALTER COLUMN "domain" SET NOT NULL;

ALTER TABLE "PeerStateFeed" DROP CONSTRAINT "PeerStateFeed_pkey";
ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_pkey"
  PRIMARY KEY ("peerDomain", account, domain, "eventType", "subjectAccount", "subjectDomain");

DROP INDEX "PeerStateFeedVersion_peer_key_idx";
CREATE INDEX "PeerStateFeedVersion_peer_key_idx" ON "PeerStateFeedVersion"
  ("peerDomain", account, domain, "eventType", "subjectAccount", "subjectDomain", "feedId");

ALTER TABLE "PeerStateFeed" DROP CONSTRAINT "PeerStateFeed_subject_check";
ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_subject_check" CHECK (
  ("eventType" IN ('P2P_INTENT', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT')
    AND "subjectAccount" <> '' AND "subjectDomain" <> '')
  OR
  ("eventType" NOT IN ('P2P_INTENT', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT')
    AND "subjectAccount" = '' AND "subjectDomain" = '')
);
