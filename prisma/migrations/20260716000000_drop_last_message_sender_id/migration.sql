-- Drop MessageThread.lastMessageSenderId: the conversation-list DTO no longer embeds the sender id, and
-- the local-first web client derives the sender (name/id) from its own cached messages. The column had no
-- remaining reader. lastMessagePreview stays (still read by the admin group list); lastMessageAt +
-- lastMessageSeq stay (sort key + unread-count cursor). Destructive — historical data not preserved.
ALTER TABLE "MessageThread" DROP COLUMN IF EXISTS "lastMessageSenderId";
