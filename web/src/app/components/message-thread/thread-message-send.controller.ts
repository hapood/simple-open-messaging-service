import { stringifyTextMessageContent } from '../../../../../shared/text-message-content';
import { withMessageContentQuote } from '../../../../../shared/message-content-quote';
import type { ChatSendIntent } from '../../lib/chat-input/chat-input.component';
import type { StandardResponse } from '../../services/model';
import type { StoredNonMediaSendContent } from '../../services/send-outbox-storage';
import type { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import type { MessageThreadAdapter } from './message-thread-adapter';

export interface ThreadMessageSendHost {
  threadId(): number | undefined;
  consumeQuote(): { seq?: number } | null;
  newClientMessageId(): string;
  surfaceFailure(response: StandardResponse<unknown>, threadId: number): void;
}

/** Non-media admission and execution. No rendered message or history mutation participates. */
export class ThreadMessageSendController {
  constructor(
    private readonly adapter: MessageThreadAdapter,
    private readonly host: ThreadMessageSendHost,
    private readonly outbox: ThreadSendOutbox,
  ) {}

  async text(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const quote = this.host.consumeQuote();
    const content = stringifyTextMessageContent({ text: trimmed });
    await this.admit({ type: 'PURE_TEXT', content: quote?.seq === undefined
      ? content : withMessageContentQuote(content, { seq: quote.seq }) });
  }

  async link(generationId: string): Promise<void> {
    await this.admit({ type: 'LINK', generationId });
  }

  async contact(contact: Extract<ChatSendIntent, { kind: 'contact' }>): Promise<void> {
    await this.admit({ type: 'CONTACT_CARD', target: contact.target });
  }

  private async admit(item: StoredNonMediaSendContent): Promise<void> {
    const threadId = this.host.threadId();
    if (threadId === undefined) return;
    const task = { clientMessageId: this.host.newClientMessageId(), threadId, item };
    await this.outbox.enqueue(task);
    await this.execute(task);
  }

  async execute(task: { clientMessageId: string; threadId: number; item: StoredNonMediaSendContent }): Promise<void> {
    try {
      const response = await this.adapter.sendIntent(task);
      if (response.code !== 0) {
        this.outbox.setPhase(task.clientMessageId, 'failed');
        this.host.surfaceFailure(response, task.threadId);
      } else {
        await this.outbox.confirm(task.threadId, [task.clientMessageId]);
      }
    } catch {
      this.outbox.setPhase(task.clientMessageId, 'failed');
    }
  }
}
