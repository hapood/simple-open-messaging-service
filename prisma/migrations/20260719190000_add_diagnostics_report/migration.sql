-- Client-uploaded diagnostic log bundles (Rust logs + a webview console capture + a version manifest)
-- for field support. The reporter is pinned to the authenticated user; the bundle FILE lives under
-- data/diagnostics/ (sha256-addressed, atomic tmp+rename publish — no refcount; GC unlinks it only when
-- no row references it). Soft-deleted via isDeleted; the file itself is hard-unlinked by
-- DiagnosticsGcService (uploaded blobs are not subject to the no-hard-delete rule for DB rows).
-- Greenfield: no data migration.
CREATE TABLE "DiagnosticsReport" (
    "id"             SERIAL       NOT NULL,
    "reporterUserId" INTEGER      NOT NULL,
    "bundlePath"     VARCHAR(255) NOT NULL,
    "bundleBytes"    INTEGER      NOT NULL,
    "manifest"       JSONB        NOT NULL,
    "status"         VARCHAR(16)  NOT NULL DEFAULT 'new',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "isDeleted"      BOOLEAN      NOT NULL DEFAULT false,

    CONSTRAINT "DiagnosticsReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiagnosticsReport_reporterUserId_idx" ON "DiagnosticsReport"("reporterUserId");
CREATE INDEX "DiagnosticsReport_createdAt_idx" ON "DiagnosticsReport"("createdAt");
CREATE INDEX "DiagnosticsReport_status_idx" ON "DiagnosticsReport"("status");

ALTER TABLE "DiagnosticsReport" ADD CONSTRAINT "DiagnosticsReport_reporterUserId_fkey"
  FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
