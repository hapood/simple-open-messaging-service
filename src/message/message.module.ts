import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { GatewayModule } from '../gateway/gateway.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { ThreadFeedService } from './thread-feed.service.js';
import { MessageService } from './message.service.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';
import { MessageVisibilityService } from './message-visibility.service.js';
import { DeletedMessageService } from './deleted-message.service.js';
import { MessageReportService } from './message-report.service.js';
import { ThreadHistoryService } from './thread-history.service.js';
import { ThreadPreviewModule } from './thread-preview.module.js';
import { ThreadReadPositionService } from './thread-read-position.service.js';
import { ContactCardProfileService } from './contact-card/contact-card-profile.service.js';

@Module({
  // LinkPreviewModule: MessageService inlines a LINK card's og:image (digest → base64) on the wire.
  providers: [
    ThreadFeedService,
    MessageService,
    MessageVisibilityService,
    DeletedMessageService,
    MessageReportService,
    ThreadHistoryService,
    ThreadReadPositionService,
    ContactCardProfileService,
  ],
  imports: [
    EventEmitterModule,
    LinkPreviewModule,
    DurableTaskModule,
    ThreadPreviewModule,
    GatewayModule,
  ],
  exports: [
    ThreadFeedService,
    MessageService,
    MessageVisibilityService,
    DeletedMessageService,
    MessageReportService,
    ThreadHistoryService,
    ThreadReadPositionService,
    ContactCardProfileService,
  ],
})
export class MessageModule {}
