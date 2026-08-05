CREATE TYPE "MessageReportStatus" AS ENUM ('PENDING', 'UPHELD', 'REJECTED');

CREATE TABLE "MessageReport" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "messageId" bigint NOT NULL,
  "threadId" integer NOT NULL,
  "messageSeq" integer NOT NULL,
  "reporterId" integer NOT NULL,
  "status" "MessageReportStatus" DEFAULT 'PENDING' NOT NULL,
  "reviewedByAdminId" integer,
  "reviewedAt" timestamp(3),
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "MessageReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "MessageReport_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "MessageReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "MessageReport_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "Admin"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "MessageReport_reporterId_messageId_key" ON "MessageReport" USING btree ("reporterId", "messageId");
CREATE INDEX "MessageReport_status_createdAt_idx" ON "MessageReport" USING btree ("status", "createdAt" DESC);
CREATE INDEX "MessageReport_messageId_idx" ON "MessageReport" USING btree ("messageId");
