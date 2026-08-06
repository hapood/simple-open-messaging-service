import { forwardRef, Module } from '@nestjs/common';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';
import { MediaAssetService } from './media-asset.service.js';
import { MediaAccessService } from './media-access.service.js';
import { MessageModule } from '../message/message.module.js';
import { QuotaModule } from '../quota/quota.module.js';
import { ResumableUploadService } from './resumable-upload.service.js';

@Module({
  // MessageModule provides MessageService — the media upload routes promote a staged send to a real
  // Message when the request carries an x-client-message-id header. MessageFanoutService is @Global
  // (MessageFanoutModule), so no import is needed for it.
  // forwardRef breaks the module cycle Upload -> Message -> LinkPreview -> Upload. The callback also
  // defers the ESM binding read until every module has finished initializing.
  imports: [forwardRef(() => MessageModule), QuotaModule],
  controllers: [UploadController],
  providers: [
    UploadService,
    MediaAssetService,
    MediaAccessService,
    ResumableUploadService,
  ],
  // MediaAccessService is exported so bootstrap.ts can resolve it via app.get() for the /uploads/
  // preHandler gate (the gate runs outside DI's request scope, on the Fastify root instance).
  // AvatarStackService is exported so NotificationQueryService (in MessageFanoutModule, which imports this
  // module) can inject it to composite the notification icon.
  // MediaAssetService is exported so MediaAssetGcService (admin layer) can publish salvaged blobs.
  exports: [UploadService, MediaAccessService, MediaAssetService, ResumableUploadService],
})
export class UploadModule {}
