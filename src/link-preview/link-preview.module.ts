import { forwardRef, Module } from '@nestjs/common';
import { SafeFetchService } from './safe-fetch.service.js';
import { OpenGraphService } from './open-graph.service.js';
import { LinkPreviewService } from './link-preview.service.js';
import { LinkPreviewController } from './link-preview.controller.js';
import { UploadModule } from '../upload/upload.module.js';

/**
 * Web link card (OpenGraph preview) feature. The SSRF-safe fetch + OG parser create short-lived
 * in-memory generations whose optional artwork is stored in the shared CAS. LinkPreviewService is
 * exported for LINK send consumption and temporary preview-asset authorization.
 */
@Module({
  // LinkPreviewService stores fetched card assets in CAS. forwardRef pairs with UploadModule's deferred
  // MessageModule import to break Upload -> Message -> LinkPreview -> Upload under native ESM initialization.
  imports: [forwardRef(() => UploadModule)],
  controllers: [LinkPreviewController],
  providers: [SafeFetchService, OpenGraphService, LinkPreviewService],
  exports: [LinkPreviewService],
})
export class LinkPreviewModule {}
