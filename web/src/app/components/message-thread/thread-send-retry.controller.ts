import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
import type {
  PendingSendResource,
  ThreadSendOutbox,
} from '../../services/thread-send-outbox.service';
import type { ThreadOptimisticController } from './thread-optimistic.controller';

export interface ThreadSendRetryHandlers {
  webGallery(
    clientMessageId: string,
    parts: Extract<PendingSendResource, { type: 'web-gallery' }>['parts'],
    item: CbItem<ChatItemData>,
  ): void;
  nativeGallery(
    clientMessageId: string,
    parts: Extract<PendingSendResource, { type: 'native-gallery' }>['parts'],
    item: CbItem<ChatItemData>,
  ): void;
  voice(
    clientMessageId: string,
    resource: Extract<PendingSendResource, { type: 'voice' }>,
    item: CbItem<ChatItemData>,
  ): void;
  nativeAttachment(
    clientMessageId: string,
    resource: Extract<PendingSendResource, { type: 'native-attachment' }>,
    item: CbItem<ChatItemData>,
  ): void;
  webAttachment(
    clientMessageId: string,
    resource: Extract<PendingSendResource, { type: 'web-attachment' }>,
    item: CbItem<ChatItemData>,
  ): Promise<void>;
  text(item: CbItem<ChatItemData>): void;
}

/** Resolves retained retry resources and dispatches exactly one replay path. */
export class ThreadSendRetryController {
  constructor(
    private readonly outbox: ThreadSendOutbox,
    private readonly optimistic: ThreadOptimisticController,
    private readonly handlers: ThreadSendRetryHandlers,
  ) {}

  async retry(clientMessageId: string): Promise<void> {
    const item = await this.optimistic.beginRetry(clientMessageId);
    if (!item) return;
    const resource = this.outbox.resource(clientMessageId);
    if (!resource) {
      if (!item.data.serverGap) this.handlers.text(item);
      return;
    }
    switch (resource.type) {
      case 'web-gallery':
        this.handlers.webGallery(clientMessageId, resource.parts, item);
        return;
      case 'native-gallery':
        this.handlers.nativeGallery(clientMessageId, resource.parts, item);
        return;
      case 'voice':
        this.handlers.voice(clientMessageId, resource, item);
        return;
      case 'native-attachment':
        this.handlers.nativeAttachment(clientMessageId, resource, item);
        return;
      case 'web-attachment':
        await this.handlers.webAttachment(clientMessageId, resource, item);
    }
  }
}
