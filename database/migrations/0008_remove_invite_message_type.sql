ALTER TABLE "UploadSession" DROP CONSTRAINT "UploadSession_partIntent_check";

ALTER TABLE "Message" ALTER COLUMN "contentType" TYPE text USING "contentType"::text;
ALTER TABLE "PendingMedia" ALTER COLUMN "contentType" TYPE text USING "contentType"::text;
ALTER TABLE "UploadSession" ALTER COLUMN "contentType" TYPE text USING "contentType"::text;
ALTER TABLE "UploadSession" ALTER COLUMN "partIntent" TYPE text USING "partIntent"::text;

DROP TYPE "ContentType";
CREATE TYPE "ContentType" AS ENUM (
  'PURE_TEXT', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO', 'LINK', 'CALL', 'FORWARD', 'GALLERY', 'SYSTEM'
);

ALTER TABLE "Message" ALTER COLUMN "contentType" TYPE "ContentType" USING "contentType"::"ContentType";
ALTER TABLE "PendingMedia" ALTER COLUMN "contentType" TYPE "ContentType" USING "contentType"::"ContentType";
ALTER TABLE "UploadSession" ALTER COLUMN "contentType" TYPE "ContentType" USING "contentType"::"ContentType";
ALTER TABLE "UploadSession" ALTER COLUMN "partIntent" TYPE "ContentType" USING "partIntent"::"ContentType";

ALTER TABLE "UploadSession"
  ADD CONSTRAINT "UploadSession_partIntent_check" CHECK ("partIntent" <> 'GALLERY'::"ContentType");
