-- Add the client-supplied idempotency key to Message. Nullable + a partial unique index (NULLs are
-- distinct in the WHERE clause) so legacy sends that omit it coexist, while a retried send with the
-- same UUID dedups against the original row. Mirrors Prisma's generated DDL for a nullable @unique
-- @db.VarChar(36) field on Postgres.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "clientMessageId" VARCHAR(36);

-- CreateIndex (partial: NULLs do not conflict)
CREATE UNIQUE INDEX "Message_clientMessageId_key" ON "Message"("clientMessageId") WHERE "clientMessageId" IS NOT NULL;
