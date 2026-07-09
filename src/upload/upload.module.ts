import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';
import { MediaAssetService } from './media-asset.service.js';
import { MediaAccessService } from './media-access.service.js';

@Module({
  controllers: [UploadController],
  providers: [UploadService, MediaAssetService, MediaAccessService],
  // MediaAccessService is exported so bootstrap.ts can resolve it via app.get() for the /uploads/
  // preHandler gate (the gate runs outside DI's request scope, on the Fastify root instance).
  exports: [UploadService, MediaAccessService],
})
export class UploadModule {}
