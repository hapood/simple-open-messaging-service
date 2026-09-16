-- Join-application attention belongs to the per-account thread head. A read
-- watermark of -1 disables manager-only attention for non-managers; zero stays
-- the valid position before the first application is allocated.
ALTER TABLE public."AccountThreadState"
  ALTER COLUMN "joinRequestReadFeedId" SET DEFAULT -1;

-- Preserve the read positions published by the temporary client-state head,
-- then retire that duplicate source of truth. Managers without such a head
-- retain their existing watermark; ordinary members receive the disabled sentinel.
UPDATE public."AccountThreadState" state
SET "joinRequestReadFeedId" = CASE
  WHEN state.role IN ('OWNER', 'ADMIN') THEN LEAST(
    state."joinRequestEndFeedId",
    GREATEST(
      0,
      state."joinRequestReadFeedId",
      COALESCE((
        SELECT CASE
          WHEN feed.body ->> 'readFeedId' ~ '^(0|[1-9][0-9]*)$'
            THEN (feed.body ->> 'readFeedId')::integer
          ELSE 0
        END
        FROM public."ClientStateFeed" feed
        JOIN public."MessageThread" thread
          ON thread.id = state."threadId"
         AND thread."groupAccount" = feed.account
        WHERE feed."userId" = state."accountId"
          AND feed."eventType" = 'GROUP_JOIN_REQUEST_HEAD'
        LIMIT 1
      ), 0)
    )
  )
  ELSE -1
END;

DELETE FROM public."ClientStateFeed"
WHERE "eventType" = 'GROUP_JOIN_REQUEST_HEAD';

ALTER TABLE public."AccountThreadState"
  ADD CONSTRAINT "AccountThreadState_joinRequestEndFeedId_check"
    CHECK ("joinRequestEndFeedId" >= 0),
  ADD CONSTRAINT "AccountThreadState_groupInviteEndFeedId_check"
    CHECK ("groupInviteEndFeedId" >= 0),
  ADD CONSTRAINT "AccountThreadState_joinRequestReadFeedId_check"
    CHECK ("joinRequestReadFeedId" >= -1
      AND "joinRequestReadFeedId" <= "joinRequestEndFeedId");
