-- Profile selection coordinates are separate from immutable profile identity.
-- A fresh database is required for this breaking protocol cutover; old rows are
-- not reinterpreted or backfilled as intent-selected profiles.
ALTER TABLE public."AccountThreadState"
  ADD COLUMN "profileSourceId" integer,
  ADD CONSTRAINT "AccountThreadState_profileSourceId_check"
    CHECK ("profileSourceId" IS NULL OR "profileSourceId" > 0);

-- This is one mutable current member fact. Message-selected revisions and the
-- message source seq update it in place without advancing its Meta feedId.
ALTER TABLE public."GroupMetaMemberFeed"
  ADD COLUMN "profileSourceSeq" integer,
  ADD CONSTRAINT "GroupMetaMemberFeed_profileSourceSeq_check"
    CHECK ("profileSourceSeq" IS NULL OR "profileSourceSeq" > 0);

-- A new P2P establishment selects the peer's intent, not a message from an
-- earlier establishment of this same thread. Retain the existing account-then-
-- participant lock order and revision-based thread-feed publication.
CREATE OR REPLACE FUNCTION public.thread_feed_after_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE participant record;
DECLARE seed_revision boolean;
BEGIN
  IF NEW."threadId" IS NULL OR NOT NEW.established THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    seed_revision := NEW.kind = 'P2P';
  ELSE
    IF OLD.active IS NOT DISTINCT FROM NEW.active
      AND OLD.established IS NOT DISTINCT FROM NEW.established
      AND OLD."threadId" IS NOT DISTINCT FROM NEW."threadId" THEN RETURN NEW; END IF;
    seed_revision := NEW.kind = 'P2P'
      AND (NOT OLD.established OR (NOT OLD.active AND NEW.active));
  END IF;
  FOR participant IN
    SELECT s."accountId", intent."profileRev" AS "profileRev"
    FROM "AccountThreadState" s
    JOIN "Account" a ON a.id = s."accountId"
    LEFT JOIN "RelationshipIntent" intent ON NEW.kind = 'P2P' AND intent."pairId" = NEW.id
      AND intent."authorSide" = CASE
        WHEN NEW."endpointAType" = 'USER' AND NEW."endpointAAccount" = a.account
          AND NEW."endpointADomain" = 'local' THEN 'B' ELSE 'A' END
    WHERE s."threadId" = NEW."threadId"
      AND ((NEW."endpointAType" = 'USER' AND NEW."endpointAAccount" = a.account
        AND NEW."endpointADomain" = 'local')
        OR (NEW."endpointBType" = 'USER' AND NEW."endpointBAccount" = a.account
          AND NEW."endpointBDomain" = 'local'))
    ORDER BY s."accountId"
  LOOP
    PERFORM 1 FROM "Account" WHERE id = participant."accountId" FOR NO KEY UPDATE;
    UPDATE "AccountThreadState" s
    SET "threadFeedId" = 0,
        "threadProfileRev" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN participant."profileRev" ELSE s."threadProfileRev" END,
        "profileSourceId" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN NULL ELSE s."profileSourceId" END
    WHERE s."accountId" = participant."accountId" AND s."threadId" = NEW."threadId";
  END LOOP;
  RETURN NEW;
END;
$$;

-- A participant inserted after establishment must use the same intent source.
CREATE OR REPLACE FUNCTION public.thread_feed_after_participant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE initial_rev integer;
BEGIN
  SELECT intent."profileRev" INTO initial_rev
  FROM "RelationshipPair" pair
  JOIN "Account" self ON self.id = NEW."accountId"
  LEFT JOIN "RelationshipIntent" intent ON pair.kind = 'P2P' AND intent."pairId" = pair.id
    AND intent."authorSide" = CASE
      WHEN pair."endpointAType" = 'USER' AND pair."endpointAAccount" = self.account
        AND pair."endpointADomain" = 'local' THEN 'B' ELSE 'A' END
  WHERE pair."threadId" = NEW."threadId" AND pair.established
    AND ((pair."endpointAType" = 'USER' AND pair."endpointAAccount" = self.account
      AND pair."endpointADomain" = 'local')
      OR (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = self.account
        AND pair."endpointBDomain" = 'local'));
  IF initial_rev IS NOT NULL AND (initial_rev IS DISTINCT FROM NEW."threadProfileRev"
    OR NEW."profileSourceId" IS NOT NULL) THEN
    UPDATE "AccountThreadState" SET "threadProfileRev" = initial_rev,
      "profileSourceId" = NULL
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
