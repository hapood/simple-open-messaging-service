-- Relax Friendship.reqMessage to 255 (match lastMessagePreview / bio convention).
ALTER TABLE "Friendship" ALTER COLUMN "reqMessage" TYPE VARCHAR(255);
