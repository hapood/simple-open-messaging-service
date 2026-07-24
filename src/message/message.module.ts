import { Module } from '@nestjs/common';
import { MessageService } from './message.service.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';

@Module({
  // LinkPreviewModule: MessageService inlines a LINK card's og:image (digest → base64) on the wire.
  providers: [MessageService],
  imports: [LinkPreviewModule],
  exports: [MessageService],
})
export class MessageModule {}
