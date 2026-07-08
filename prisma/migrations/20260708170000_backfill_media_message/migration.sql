-- Backfill MediaMessage for every existing media message (IMAGE/FILE/VIDEO/AUDIO) sent before the
-- per-object authz gate shipped. Without this, the /uploads/shards/* gate would 401 on ALL historical
-- chat media (no MediaMessage row → no thread membership proof) — the same breakage class as the
-- group-avatar migration, applied to message media.
--
-- regexp_matches(..., 'g') emits one row per match (a text[] with the digest in [1]); CROSS JOIN
-- LATERAL fans each message out to one row per distinct digest it references. ON CONFLICT makes it
-- idempotent and dedupes album repeats / re-runs. Legacy-flat URLs (no /uploads/shards/ path) match
-- nothing and are correctly left out — they carry no digest and stay auth-n-only.

INSERT INTO "MediaMessage" ("messageId", "threadId", "digest", "createdAt")
SELECT m."id", m."threadId", matches[1] AS digest, CURRENT_TIMESTAMP
FROM "Message" m
CROSS JOIN LATERAL regexp_matches(
    m."content",
    '/uploads/shards/[0-9a-f]{2}/[0-9a-f]{2}/([0-9a-f]{64})\.',
    'g'
) AS matches
WHERE m."contentType" IN ('IMAGE', 'FILE', 'VIDEO', 'AUDIO')
ON CONFLICT ("messageId", "digest") DO NOTHING;
