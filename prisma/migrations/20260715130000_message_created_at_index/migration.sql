-- Cross-thread "messages since T" index for the paginated /notifications/missed catch-up. Backs the
-- global createdAt range scan (joined to ThreadParticipant for membership). See Message.@@index([createdAt]).

CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
