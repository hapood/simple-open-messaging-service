import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { UploadModule } from './upload.module.js';
import { MessageModule } from '../message/message.module.js';
import { QuotaModule } from '../quota/quota.module.js';

/**
 * Resumable media upload: the upload-side staged-send-to-message promotion.
 * The promotion handoff (the `x-client-message-id` route header) needs
 * `MessageService`, which is why this feature sits in its own module on top
 * of the CAS core — `UploadModule` stays free of `MessageModule` and the
 * module graph stays acyclic:
 * `ResumableUpload → Message → LinkPreview → Upload → Quota`.
 */
@Module({
  imports: [UploadModule, MessageModule, QuotaModule],
  controllers: [UploadController],
  providers: [ResumableUploadService],
  exports: [ResumableUploadService],
})
export class ResumableUploadModule {}
