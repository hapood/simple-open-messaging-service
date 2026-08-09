-- A closed friendship or group subscription retains its audience row so
-- already allocated discovery changes remain drainable. The inclusive
-- boundary is zero when no message has ever been allocated for that target.
ALTER TABLE "ThreadAudience"
  DROP CONSTRAINT "ThreadAudience_scope_check",
  DROP CONSTRAINT "ThreadAudience_deliverThroughChangeId_check";

ALTER TABLE "ThreadAudience"
  ADD CONSTRAINT "ThreadAudience_scope_check" CHECK (
    (
      "scope" = 'THREAD'
      AND "creatorUserId" IS NULL
    )
    OR
    (
      "scope" = 'CREATOR'
      AND "targetDomain" <> 'local'
      AND "localUserId" IS NULL
      AND "creatorUserId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "ThreadAudience_deliverThroughChangeId_check" CHECK (
    "deliverThroughChangeId" IS NULL OR "deliverThroughChangeId" >= 0
  );
