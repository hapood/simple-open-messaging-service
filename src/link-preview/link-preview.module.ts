import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module.js';
import { SafeFetchService } from './safe-fetch.service.js';
import { OpenGraphService } from './open-graph.service.js';
import { LinkPreviewService } from './link-preview.service.js';
import { LinkPreviewController } from './link-preview.controller.js';

/**
 * Web link card (OpenGraph preview) feature. The SSRF-safe fetch + OG parser + image localizer live
 * here; UploadModule provides UploadService (CAS ingest + sharp), and QuotaService is @Global so no
 * import is needed. LinkPreviewService is exported so MessageController (registered directly on
 * AppModule) can inject it to enrich a LINK send server-side.
 */
@Module({
  imports: [UploadModule],
  controllers: [LinkPreviewController],
  providers: [SafeFetchService, OpenGraphService, LinkPreviewService],
  exports: [LinkPreviewService],
})
export class LinkPreviewModule {}
