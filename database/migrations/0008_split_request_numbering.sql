-- Applications and invitations number their projection streams independently
-- on the group: GroupMetaFeed carries one counter per direction, so every
-- manager's projection copy shares the group's event numbers and GC deletions
-- can never reuse one. The feedId column stays; only the allocation source and
-- the per-manager uniqueness scope change.
ALTER TABLE public."GroupMetaFeed"
  ADD COLUMN "applicationFeedAllocatedThrough" integer NOT NULL DEFAULT 0,
  ADD COLUMN "invitationFeedAllocatedThrough" integer NOT NULL DEFAULT 0;

UPDATE public."GroupMetaFeed" g SET
  "applicationFeedAllocatedThrough" = COALESCE((SELECT MAX(r."feedId")
    FROM public."GroupRequestProjection" r
    WHERE r."threadId" = g."threadId" AND r.direction = 'APPLICATION'), 0),
  "invitationFeedAllocatedThrough" = COALESCE((SELECT MAX(r."feedId")
    FROM public."GroupRequestProjection" r
    WHERE r."threadId" = g."threadId" AND r.direction = 'INVITATION'), 0);

ALTER TABLE public."GroupMetaFeed"
  ADD CONSTRAINT "GroupMetaFeed_applicationFeedAllocatedThrough_check"
    CHECK ("applicationFeedAllocatedThrough" >= 0),
  ADD CONSTRAINT "GroupMetaFeed_invitationFeedAllocatedThrough_check"
    CHECK ("invitationFeedAllocatedThrough" >= 0);

DROP INDEX public."GroupRequestProjection_manager_feed_key";
CREATE UNIQUE INDEX "GroupRequestProjection_manager_feed_key"
  ON public."GroupRequestProjection" USING btree ("managerUserId", direction, "feedId");
