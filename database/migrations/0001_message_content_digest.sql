-- Message provenance: content digest, CONFIRMED local state, and provenance query index.
--
-- Federation v1 Core Protocol §6.1.1 mandates RFC 8785 (JCS) canonical serialization for
-- `JsonObjectString` fields so a content digest (`sha256(JCS(JSON.parse(content)))`) is stable
-- across hops. This migration persists that digest per message, adds a `CONFIRMED` materialization
-- state reached after an inbound processing receipt's recomputed digest matches the retained one,
-- and indexes `(threadId, seq, contentDigest)` for `POST /s2s/v1/message-provenance`.

-- New terminal local state: content digest confirmed against the publisher's processing receipt.
-- `READY` remains the visible baseline; `CONFIRMED` is an upgrade on top of it and does not change
-- which messages are published or shown.
ALTER TYPE public."MessageLocalState" ADD VALUE IF NOT EXISTS 'CONFIRMED';

-- Hop-independent content digest of the canonical form of `content`. NULL for pre-existing rows
-- and for messages not covered by a digest; backfill is out of scope for this migration.
ALTER TABLE public."Message"
  ADD COLUMN IF NOT EXISTS "contentDigest" character varying(64);

-- Serves the provenance query: locate the retained digest for `(threadId, seq)` and compare with
-- the supplied `contentDigest`. Partial on `contentDigest IS NOT NULL`.
CREATE INDEX IF NOT EXISTS "Message_threadId_seq_contentDigest_idx"
  ON public."Message" USING btree ("threadId", seq, "contentDigest")
  WHERE ("contentDigest" IS NOT NULL);
