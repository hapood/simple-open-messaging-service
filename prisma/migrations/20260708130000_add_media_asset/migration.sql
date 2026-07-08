-- MediaAsset: content-addressed media (sha256 dedup + reference counting).
-- One physical file per digest at uploads/shards/<digest[0:2]>/<digest[2:4]>/<digest>.<ext>;
-- the GC sweep reclaims file + row when refs reaches 0. Avatars are NOT tracked here (they keep
-- the legacy uploads/<base>-<size>.webp multi-size sharp pipeline). No FK to Message — the URL
-- embeds the digest, so the link is by-value.
--
-- Only the ref count + audit columns are stored. The on-disk extension and MIME are NOT stored:
-- ext is recoverable from the filename (<digest>.<ext>), MIME is mapped by @fastify/static from
-- the ext at serving time, and the upload response MIME comes from the request — storing them
-- would be pure redundancy. The GC path globs <digest>.* to unlink.

CREATE TABLE "MediaAsset" (
    "digest" VARCHAR(64) NOT NULL,
    "bytes" BIGINT NOT NULL,
    "refs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("digest")
);
CREATE INDEX "MediaAsset_refs_idx" ON "MediaAsset"("refs");
