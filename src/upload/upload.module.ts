import { Module } from '@nestjs/common';
import { UploadService } from './upload.service.js';
import { MediaAssetService } from './media-asset.service.js';
import { MediaAccessService } from './media-access.service.js';
import { MediaMetadataService } from './media-metadata.service.js';

@Module({
  // CAS core: content-addressed media storage and authorization. The staged
  // send promotion routes and ResumableUploadService live in
  // ResumableUploadModule, which sits on top of this module and MessageModule
  // so no module below MessageModule imports it back.
  controllers: [],
  providers: [
    UploadService,
    MediaAssetService,
    MediaAccessService,
    MediaMetadataService,
  ],
  // MediaAccessService is exported so bootstrap.ts can resolve it via app.get() for the /uploads/
  // preHandler gate (the gate runs outside DI's request scope, on the Fastify root instance).
  exports: [UploadService, MediaAccessService, MediaAssetService],
})
export class UploadModule {}
