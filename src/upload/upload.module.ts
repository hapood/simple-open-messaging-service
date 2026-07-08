import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';
import { MediaAssetService } from './media-asset.service.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  // PrismaService is provided per-module (no global PrismaModule) — same pattern as MessageModule.
  controllers: [UploadController],
  providers: [UploadService, MediaAssetService, PrismaService],
  exports: [UploadService],
})
export class UploadModule {}
