-- Cap Friendship.reqMessage at 200 chars (friend-request reason/note; local + federated).
-- Existing values are all "" (the field was never wired through the API before), so the
-- narrowing to VARCHAR(200) is safe.
ALTER TABLE "Friendship" ALTER COLUMN "reqMessage" TYPE VARCHAR(200);
