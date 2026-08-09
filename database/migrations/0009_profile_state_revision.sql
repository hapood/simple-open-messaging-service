CREATE TABLE "ProfileStateRevision" (
  "userId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "subjectUserId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ProfileStateRevision_pkey" PRIMARY KEY ("userId", "subjectUserId"),
  CONSTRAINT "ProfileStateRevision_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "ProfileStateRevision_userId_revision_idx" ON "ProfileStateRevision" ("userId", "revision");
