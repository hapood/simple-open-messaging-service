ALTER TABLE "ThreadMember" ADD COLUMN "firstSentSeq" integer;

UPDATE "ThreadMember" member
SET "firstSentSeq" = boundaries."firstSentSeq",
    "lastSentSeq" = boundaries."lastSentSeq"
FROM (
  SELECT member_row.id,
         MIN(message.seq)::integer AS "firstSentSeq",
         MAX(message.seq)::integer AS "lastSentSeq"
  FROM "ThreadMember" member_row
  JOIN "User" author ON author.id = member_row."userId"
  JOIN "MessageThread" thread ON thread.id = member_row."threadId"
  JOIN "Group" group_state ON group_state.id = thread."groupId"
  JOIN "Message" message
    ON message."threadId" = member_row."threadId"
   AND message."creatorAccount" = author.account
   AND message."creatorDomain" = author.domain
  WHERE thread.type = 'GROUP'
    AND group_state.domain = 'local'
  GROUP BY member_row.id
) boundaries
WHERE member.id = boundaries.id;

ALTER TABLE "ThreadMember"
  ADD CONSTRAINT "ThreadMember_firstSentSeq_check"
  CHECK ("firstSentSeq" IS NULL OR "firstSentSeq" > 0);

CREATE INDEX "ThreadMember_threadId_left_firstSentSeq_idx"
  ON "ThreadMember" ("threadId", "left", "firstSentSeq");
