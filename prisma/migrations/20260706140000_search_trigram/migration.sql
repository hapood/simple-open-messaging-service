-- trigram GIN index on Message.content backs the cross-conversation ILIKE substring scan used by
-- POST /search/global (the messages wing: PURE_TEXT body matches). Without it, a global search
-- degrades to a full table scan over Message. pg_trgm's gin_trgm_ops supports ILIKE '%kw%'
-- (any-substring) via trigram extraction, so the dominant PURE_TEXT case is index-served.
--
-- FILE-name matches cast content (a JSON string) to jsonb first; that expression is not covered by
-- this index, but FILE volume is a small fraction of all messages, so a re-check over the FILE subset
-- is acceptable. PURE_TEXT — the hot path — is fully indexed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Message_content_trgm_idx" ON "Message" USING gin (content gin_trgm_ops);
