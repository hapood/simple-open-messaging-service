-- mustChangePassword: set when an admin generates (or re-initializes) a user's INITIAL password. While
-- true, the user is forced to set their own password on first login — the initial password is a one-time
-- bootstrap, not an ongoing credential. Cleared when the user sets their own password (auth/set-password).
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
