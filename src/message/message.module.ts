import { Module } from '@nestjs/common';
import { MessageService } from './message.service.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';
import { UserBlockModule } from '../user-block/user-block.module.js';
import { MessageVisibilityService } from './message-visibility.service.js';

@Module({
  // LinkPreviewModule: MessageService inlines a LINK card's og:image (digest → base64) on the wire.
  providers: [MessageService, MessageVisibilityService],
  imports: [LinkPreviewModule, UserBlockModule],
  exports: [MessageService, MessageVisibilityService],
})
export class MessageModule {}
