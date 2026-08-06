-- ═══════════════════════ Phase 7: GALLERY multi-file + type-agnostic upload ═══════════════════════
-- GALLERY is a multi-asset bundle contentType (federation design doc §12.3 "outbound/inbound
-- unification"). Single-file sends keep their existing type (IMAGE/VIDEO/FILE/AUDIO) and single-object
-- content shape; GALLERY carries N items whose order is digest-sorted, because upload arrival order is
-- unreliable across parallel requests.
--
-- FileSyncProgress.payload (outbound-only, nullable) carries each uploaded file's display payload
-- {digest,url,size,family,name?,mimeType?,w?,h?,duration?} so the barrier-promote can assemble message
-- content without re-deriving display metadata from CAS. Inbound rows never set it (their content
-- arrives fully formed from the peer).

-- ADD VALUE is permitted inside a transaction block since PostgreSQL 12 (this server is PG 16).
ALTER TYPE "ContentType" ADD VALUE 'GALLERY';

ALTER TABLE "FileSyncProgress" ADD COLUMN "payload" jsonb;
