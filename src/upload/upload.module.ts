import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';
import { MediaAssetService } from './media-asset.service.js';
import { MediaAccessService } from './media-access.service.js';
import { MessageModule } from '../message/message.module.js';

@Module({
  // MessageModule provides MessageService — the media upload routes promote a staged send to a real
  // Message when the request carries an x-client-message-id header. MessageFanoutService is @Global
  // (MessageFanoutModule), so no import is needed for it.
  imports: [MessageModule],
  controllers: [UploadController],
  providers: [UploadService, MediaAssetService, MediaAccessService],
  // MediaAccessService is exported so bootstrap.ts can resolve it via app.get() for the /uploads/
  // preHandler gate (the gate runs outside DI's request scope, on the Fastify root instance).
  exports: [UploadService, MediaAccessService],
})
export class UploadModule {}
