CREATE TABLE "GroupAuditLog" (
  id bigserial PRIMARY KEY,
  "eventKey" varchar(191) NOT NULL,
  "groupUserId" integer,
  "groupAccount" varchar(31) NOT NULL,
  "groupDomain" varchar(63) NOT NULL,
  "actorType" varchar(24) NOT NULL,
  "actorUserId" integer,
  "actorAccount" varchar(31) NOT NULL,
  "actorDomain" varchar(63) NOT NULL,
  action varchar(64) NOT NULL,
  "targetType" varchar(32),
  "targetId" varchar(191),
  success boolean DEFAULT true NOT NULL,
  "errorMessage" varchar(255),
  meta jsonb,
  at timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX "GroupAuditLog_eventKey_key" ON "GroupAuditLog" ("eventKey");
CREATE INDEX "GroupAuditLog_groupUserId_at_idx" ON "GroupAuditLog" ("groupUserId", at);
CREATE INDEX "GroupAuditLog_action_at_idx" ON "GroupAuditLog" (action, at);
