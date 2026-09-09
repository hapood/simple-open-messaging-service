CREATE TABLE "CallHistory" (
  "key" text PRIMARY KEY,
  "threadId" integer NOT NULL REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  "snapshot" jsonb NOT NULL,
  "revision" integer NOT NULL,
  "terminal" boolean NOT NULL DEFAULT false,
  "messageSeq" integer
);
CREATE INDEX "CallHistory_pending_idx" ON "CallHistory"("terminal") WHERE "messageSeq" IS NULL;

-- Retired call records are discarded, never converted into new system notices.
CREATE TEMP TABLE retired_call_bundles ON COMMIT DROP AS
WITH RECURSIVE retired(id) AS (
  SELECT id FROM "ForwardBundle" WHERE messages @> '[{"contentType":"CALL"}]'::jsonb
  UNION
  SELECT d."parentBundleId" FROM "ForwardBundleDependency" d JOIN retired r ON r.id = d."childBundleId"
) SELECT id FROM retired;
CREATE TEMP TABLE retired_call_messages ON COMMIT DROP AS
SELECT id, "threadId", seq FROM "Message" WHERE "contentType" = 'CALL'
OR id IN (SELECT "messageId" FROM "ForwardMessage" WHERE "bundleId" IN (SELECT id FROM retired_call_bundles));
DELETE FROM "ForwardMessage" WHERE "messageId" IN (SELECT id FROM retired_call_messages);
DELETE FROM "MessageAsset" WHERE "messageId" IN (SELECT id FROM retired_call_messages);
DELETE FROM "MessageReport" r USING retired_call_messages m WHERE r."threadId" = m."threadId" AND r.seq = m.seq;
DELETE FROM "Message" WHERE id IN (SELECT id FROM retired_call_messages);
DELETE FROM "ForwardBundleDependency" WHERE "parentBundleId" IN (SELECT id FROM retired_call_bundles) OR "childBundleId" IN (SELECT id FROM retired_call_bundles);
DELETE FROM "ForwardBundleAsset" WHERE "bundleId" IN (SELECT id FROM retired_call_bundles);
DELETE FROM "ForwardBundle" WHERE id IN (SELECT id FROM retired_call_bundles);
UPDATE "AccountThreadState" s SET
  "unreadCount" = thread_unread_count(s, t."clearedSeq", s."lastReadSeq", s."messageEndSeq"),
  "previewSeqs" = ARRAY(SELECT p.seq FROM unnest(s."previewSeqs") AS p(seq)
    WHERE EXISTS (SELECT 1 FROM "Message" m WHERE m."threadId" = s."threadId" AND m.seq = p.seq)
    ORDER BY p.seq DESC)
FROM "MessageThread" t
WHERE t.id = s."threadId" AND t.id IN (SELECT "threadId" FROM retired_call_messages);
DELETE FROM "PendingMedia" WHERE "contentType" = 'CALL';
DELETE FROM "UploadSession" WHERE "contentType" = 'CALL' OR "partIntent" = 'CALL';

-- Recreate enum-typed columns and their checks without the retired enum label.
CREATE TEMP TABLE call_type_checks ON COMMIT DROP AS
SELECT conrelid::regclass::text AS table_name, conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'c' AND conrelid IN (
  SELECT attrelid FROM pg_attribute WHERE atttypid = '"ContentType"'::regtype
);
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM call_type_checks LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.table_name, r.conname);
  END LOOP;
END $$;
ALTER TYPE "ContentType" RENAME TO "ContentType_retired";
CREATE TYPE "ContentType" AS ENUM ('PURE_TEXT', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO', 'LINK', 'CONTACT_CARD', 'FORWARD', 'GALLERY', 'SYSTEM');
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT attrelid::regclass AS table_name, attname FROM pg_attribute
           WHERE atttypid = '"ContentType_retired"'::regtype AND attnum > 0 AND NOT attisdropped LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE "ContentType" USING %I::text::"ContentType"', r.table_name, r.attname, r.attname);
  END LOOP;
  FOR r IN SELECT * FROM call_type_checks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.table_name, r.conname, r.definition);
  END LOOP;
END $$;
DROP TYPE "ContentType_retired";
