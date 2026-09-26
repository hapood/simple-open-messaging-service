-- Only the thread feed publishes conversations. The relationship feed still
-- carries requests, but its THREAD_STATE projection has no readers or writers.
DROP TRIGGER client_thread_state_after_pair ON public."RelationshipPair";
DROP TRIGGER client_thread_state_after_participant ON public."AccountThreadState";
DROP FUNCTION public.client_thread_state_after_pair();
DROP FUNCTION public.client_thread_state_after_participant();
DROP FUNCTION public.publish_client_thread_state(integer, integer, bigint);

-- The pair owns lifecycle and counterpart identity. A change in lifecycle must
-- publish a thread snapshot even when no messages or unread counts change.
-- Only P2P snapshots seed from the counterpart's authored intent. After
-- activation, peer messages raise P2P revisions; only GROUP_PROFILE meta raises
-- group revisions.
CREATE FUNCTION public.thread_feed_after_pair() RETURNS trigger
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
    -- Keep the account-then-participant acquisition order used by feed writers.
    PERFORM 1 FROM "Account" WHERE id = participant."accountId" FOR NO KEY UPDATE;
    UPDATE "AccountThreadState" s
    SET "threadFeedId" = 0,
        "threadProfileRev" = CASE WHEN seed_revision AND participant."profileRev" IS NOT NULL
          THEN GREATEST(s."threadProfileRev", participant."profileRev")
          ELSE s."threadProfileRev" END
    WHERE s."accountId" = participant."accountId" AND s."threadId" = NEW."threadId";
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_feed_after_pair
  AFTER INSERT OR UPDATE OF active, established, "threadId" ON public."RelationshipPair"
  FOR EACH ROW EXECUTE FUNCTION public.thread_feed_after_pair();

-- A participant may be inserted after its pair was established. The INSERT
-- already allocated a feed ID; update it again only if a P2P intent seed
-- raises the initial revision. Group avatar revisions come from GROUP_PROFILE
-- meta instead. Block and role changes publish in the BEFORE trigger.
CREATE FUNCTION public.thread_feed_after_participant() RETURNS trigger
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
  IF initial_rev > NEW."threadProfileRev" THEN
    UPDATE "AccountThreadState" SET "threadProfileRev" = initial_rev
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_feed_after_participant
  AFTER INSERT ON public."AccountThreadState"
  FOR EACH ROW EXECUTE FUNCTION public.thread_feed_after_participant();

-- Preserve the existing block -> unread/preview reconciliation, while also
-- allocating a version for block or role alone (including an empty thread).
CREATE OR REPLACE FUNCTION public.thread_feed_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE c integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.blocked IS DISTINCT FROM OLD.blocked THEN
    SELECT "clearedSeq" INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR NO KEY UPDATE;
    NEW."unreadCount" := thread_unread_count(NEW, c, NEW."lastReadSeq", NEW."messageEndSeq");
    NEW."previewSeqs" := ARRAY(SELECT seq FROM unnest(NEW."previewSeqs") seq
      WHERE seq >= NEW."lastReadSeq" AND seq > COALESCE(c, 0)
        AND seq <= COALESCE(NEW."messageVisibleThroughSeq", NEW."messageEndSeq") ORDER BY seq DESC);
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW.alias IS DISTINCT FROM OLD.alias
    OR NEW."previewSeqs" IS DISTINCT FROM OLD."previewSeqs"
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."announcementReadFeedId" IS DISTINCT FROM OLD."announcementReadFeedId"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq"
    OR NEW."messageEndSeq" IS DISTINCT FROM OLD."messageEndSeq"
    OR NEW."tombstoneEndSeq" IS DISTINCT FROM OLD."tombstoneEndSeq"
    OR NEW."joinRequestEndFeedId" IS DISTINCT FROM OLD."joinRequestEndFeedId"
    OR NEW."groupInviteEndFeedId" IS DISTINCT FROM OLD."groupInviteEndFeedId"
    OR NEW."joinRequestReadFeedId" IS DISTINCT FROM OLD."joinRequestReadFeedId"
    OR NEW."groupMetaFeedEndId" IS DISTINCT FROM OLD."groupMetaFeedEndId"
    OR NEW."threadProfileRev" IS DISTINCT FROM OLD."threadProfileRev"
    OR NEW.blocked IS DISTINCT FROM OLD.blocked
    OR NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE "Account" SET "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  RETURN NEW;
END;
$$;

DELETE FROM public."ClientStateFeed" WHERE "eventType" = 'THREAD_STATE';
