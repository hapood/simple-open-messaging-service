import { Module } from '@nestjs/common';
import { MessageService } from './message.service.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';
import { MessageVisibilityService } from './message-visibility.service.js';
import { DeletedMessageService } from './deleted-message.service.js';
import { MessageReportService } from './message-report.service.js';

@Module({
  // LinkPreviewModule: MessageService inlines a LINK card's og:image (digest → base64) on the wire.
  providers: [
    MessageService,
    MessageVisibilityService,
    DeletedMessageService,
    MessageReportService,
  ],
  imports: [LinkPreviewModule],
  exports: [
    MessageService,
    MessageVisibilityService,
    DeletedMessageService,
    MessageReportService,
  ],
})
export class MessageModule {}
