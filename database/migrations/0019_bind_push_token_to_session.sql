DELETE FROM "PushToken";

ALTER TABLE "PushToken"
  ADD COLUMN "sessionId" integer NOT NULL,
  ADD CONSTRAINT "PushToken_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "SessionToken"(id)
    ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "PushToken_sessionId_idx"
  ON "PushToken" ("sessionId");
