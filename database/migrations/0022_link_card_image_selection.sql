ALTER TABLE "LinkCardRule"
  ADD COLUMN "imageSelection" VARCHAR(5) NOT NULL DEFAULT 'first';

ALTER TABLE "LinkCardRule"
  ADD COLUMN "descriptionSelection" VARCHAR(5) NOT NULL DEFAULT 'first';

ALTER TABLE "LinkCardRule"
  ADD CONSTRAINT "LinkCardRule_imageSelection_check"
  CHECK ("imageSelection" IN ('first', 'last'));

ALTER TABLE "LinkCardRule"
  ADD CONSTRAINT "LinkCardRule_descriptionSelection_check"
  CHECK ("descriptionSelection" IN ('first', 'last'));

UPDATE "LinkCardRule"
SET "imageSelection" = 'last',
    "descriptionSelection" = 'last',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "hostname" IN ('xiaohongshu.com', 'xhslink.com');
