import { Module } from '@nestjs/common';
import { UploadService } from './upload.service.js';
import { MediaAssetService } from './media-asset.service.js';
import { MediaMetadataService } from './media-metadata.service.js';

@Module({
  // CAS core: content-addressed media storage and authorization. The staged
  // send promotion routes and ResumableUploadService live in
  // ResumableUploadModule, which sits on top of this module and MessageModule
  // so no module below MessageModule imports it back.
  //
  // MediaAccessService lived here historically but depends on
  // MessageVisibilityService (MessageModule). Importing MessageModule would
  // recreate the Message → LinkPreview → Upload → Message cycle, so the read-side
  // authorization gate moved up to ResumableUploadModule, the lowest module that
  // can legally see both the CAS core and MessageModule.
  controllers: [],
  providers: [UploadService, MediaAssetService, MediaMetadataService],
  exports: [UploadService, MediaAssetService],
})
export class UploadModule {}
