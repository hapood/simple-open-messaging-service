ALTER TABLE "PendingMedia"
ADD COLUMN "dependsOnOriginSeq" integer;

ALTER TABLE "PendingMedia"
ADD CONSTRAINT "PendingMedia_depends_on_origin_seq_check"
CHECK ("dependsOnOriginSeq" IS NULL OR "dependsOnOriginSeq" > 0);

CREATE INDEX "PendingMedia_quote_dependency_idx"
ON "PendingMedia" ("threadId", "originDomain", "dependsOnOriginSeq");
