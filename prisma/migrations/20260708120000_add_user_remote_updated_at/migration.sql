-- Add remoteUpdatedAt to User. Federated stubs store the peer's profile revision (the peer's
-- User.updatedAt, captured when the stub's avatar/name/bio was last localized from the peer). The
-- chat-open staleness probe (GET /api/v1/s2s/users/:handle/revision) compares the peer's current
-- revision against this; a newer peer value triggers a re-pull + re-localize. Null for local users
-- (their own updatedAt is authoritative) and for stubs not yet localized.
-- See docs/federation-protocol.md (avatar federation).
ALTER TABLE "User" ADD COLUMN "remoteUpdatedAt" TIMESTAMP(3);
