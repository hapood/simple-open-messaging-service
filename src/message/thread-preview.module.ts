import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ThreadPreviewService } from './thread-preview.service.js';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [ThreadPreviewService],
  exports: [ThreadPreviewService],
})
export class ThreadPreviewModule {}
