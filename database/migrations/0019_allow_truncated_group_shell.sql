ALTER TABLE "MessageThread"
  DROP CONSTRAINT "MessageThread_groupUserId_type_check";

ALTER TABLE "MessageThread"
  ADD CONSTRAINT "MessageThread_groupUserId_type_check"
  CHECK (
    "federationTruncated"
    OR ((type = 'P2P'::"MessageThreadType") = ("groupUserId" IS NULL))
  );

COMMENT ON CONSTRAINT "MessageThread_groupUserId_type_check" ON "MessageThread" IS
  'A truncated federation thread is an inert retained shell and no longer owns a group user.';
