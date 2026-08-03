import { Module } from '@nestjs/common';
import { SafeFetchService } from './safe-fetch.service.js';
import { OpenGraphService } from './open-graph.service.js';
import { LinkPreviewService } from './link-preview.service.js';
import { LinkPreviewController } from './link-preview.controller.js';
import { UploadModule } from '../upload/upload.module.js';
import { LinkCardRuleController } from './link-card-rule.controller.js';
import { LinkCardRuleService } from './link-card-rule.service.js';

/**
 * Web link card (OpenGraph preview) feature. The SSRF-safe fetch + OG parser + thumbnail inline
 * (base64 data URI) live here — self-contained (no UploadModule: the thumbnail is inlined into the
 * content, not stored in CAS). QuotaService is @Global so no import is needed. LinkPreviewService is
 * exported so MessageController (registered directly on AppModule) can inject it to enrich a LINK
 * send server-side.
 */
@Module({
  imports: [UploadModule],
  controllers: [LinkPreviewController, LinkCardRuleController],
  providers: [
    SafeFetchService,
    OpenGraphService,
    LinkPreviewService,
    LinkCardRuleService,
  ],
  exports: [LinkPreviewService, LinkCardRuleService],
})
export class LinkPreviewModule {}
