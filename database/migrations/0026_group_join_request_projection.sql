CREATE TABLE "GroupJoinRequestProjection" (
  "managerUserId" integer NOT NULL,
  "threadId" integer NOT NULL,
  "applicantUserId" integer NOT NULL,
  "feedId" integer NOT NULL,
  "requestId" bigint NOT NULL,
  status varchar(15) NOT NULL,
  note varchar(255) DEFAULT '' NOT NULL,
  "requestedAt" timestamptz(3) NOT NULL,
  "expiresAt" timestamptz(3) NOT NULL,
  "createdAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "GroupJoinRequestProjection_pkey"
    PRIMARY KEY ("managerUserId", "threadId", "applicantUserId"),
  CONSTRAINT "GroupJoinRequestProjection_managerUserId_fkey"
    FOREIGN KEY ("managerUserId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "GroupJoinRequestProjection_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"(id) ON DELETE CASCADE,
  CONSTRAINT "GroupJoinRequestProjection_applicantUserId_fkey"
    FOREIGN KEY ("applicantUserId") REFERENCES "User"(id) ON DELETE CASCADE,
  CONSTRAINT "GroupJoinRequestProjection_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "GroupJoinRequestProjection_status_check"
    CHECK (status IN ('REQUESTED', 'ACCEPTED', 'REVOKED')),
  CONSTRAINT "GroupJoinRequestProjection_retention_check"
    CHECK ("expiresAt" > "requestedAt"
      AND "expiresAt" <= "requestedAt" + INTERVAL '7 days')
);

CREATE UNIQUE INDEX "GroupJoinRequestProjection_manager_feed_key"
  ON "GroupJoinRequestProjection" ("managerUserId", "feedId");
CREATE INDEX "GroupJoinRequestProjection_thread_feed_idx"
  ON "GroupJoinRequestProjection" ("managerUserId", "threadId", "feedId");
CREATE INDEX "GroupJoinRequestProjection_expiry_idx"
  ON "GroupJoinRequestProjection" ("expiresAt");
