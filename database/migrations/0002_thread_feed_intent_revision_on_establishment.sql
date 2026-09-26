-- A newly established P2P relationship starts at the counterpart's authored
-- intent revision, even if a retained participant had previously seen a newer
-- revision. Later eligible messages may advance the revision again.
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
    -- Match the account-then-participant acquisition order of feed writers.
    PERFORM 1 FROM "Account" WHERE id = participant."accountId" FOR NO KEY UPDATE;
    UPDATE "AccountThreadState" s
    SET "threadFeedId" = 0,
        "threadProfileRev" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN participant."profileRev" ELSE s."threadProfileRev" END
    WHERE s."accountId" = participant."accountId" AND s."threadId" = NEW."threadId";
  END LOOP;
  RETURN NEW;
END;
$$;

-- If the participant is inserted after an already established P2P pair, use
-- that pair's intent revision exactly rather than retaining a stale value.
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
  IF initial_rev IS NOT NULL AND initial_rev IS DISTINCT FROM NEW."threadProfileRev" THEN
    UPDATE "AccountThreadState" SET "threadProfileRev" = initial_rev
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
