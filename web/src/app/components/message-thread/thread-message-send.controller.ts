import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatSendIntent } from '../../lib/chat-input/chat-input.component';
import {
  toDisplayText,
  toRenderMessageEntities,
  type MentionIdentity,
} from '../../lib/message-entity';
import { stringifyTextMessageContent } from '../../../../../shared/text-message-content';
import { withMessageContentQuote } from '../../../../../shared/message-content-quote';
import type { LinkCardContent } from '../../services/link-card-generation.service';
import type { StandardResponse } from '../../services/model';
import type { ChatItemData, ChatMsgData } from '../message-cards/chat-item';
import type {
  MessageThreadAdapter,
  MessageThreadSource,
} from './message-thread-adapter';
import { MESSAGE_SEND_TIMEOUT_MS } from './message-send-timeout';

export interface ThreadMessageSendHost {
  threadId(): number | undefined;
  selfMentionIdentity(): MentionIdentity | undefined;
  consumeQuote(): ChatMsgData['quote'] | null;
  makeItem(
    clientMessageId: string,
    text: string,
    contentType: 'PURE_TEXT' | 'LINK' | 'CONTACT_CARD',
  ): CbItem<ChatMsgData>;
  newClientMessageId(): string;
  dispatch(item: CbItem<ChatItemData>): void;
  source(): MessageThreadSource | undefined;
  fail(item: CbItem<ChatItemData>): Promise<void>;
  accept(item: CbItem<ChatItemData>): Promise<void>;
  surfaceFailure(response: StandardResponse<unknown>, threadId: number): void;
}

// A missing IPC reply must not leave a message in "sending" indefinitely. A failed write is
// ambiguous; retries reuse the original clientMessageId for server-side deduplication.
function withSendTimeout<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Message send timed out')),
      MESSAGE_SEND_TIMEOUT_MS,
    );
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Owns non-media optimistic sends and their HTTP acceptance lifecycle. */
export class ThreadMessageSendController {
  constructor(
    private readonly adapter: MessageThreadAdapter,
    private readonly host: ThreadMessageSendHost,
  ) {}

  text(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const item = this.host.makeItem(
      this.host.newClientMessageId(),
      toDisplayText(trimmed),
      'PURE_TEXT',
    );
    item.data.wireText = trimmed;
    const rendered = toRenderMessageEntities(
      trimmed,
      this.host.selfMentionIdentity(),
    );
    item.data.textSegments = rendered.segments;
    item.data.mentionState = rendered.mentionState;
    item.data.quote = this.host.consumeQuote() ?? undefined;
    this.host.dispatch(item);
    this.dispatchText(item);
  }

  link(generationId: string, content: LinkCardContent): void {
    if (!this.host.threadId()) return;
    const item = this.host.makeItem(
      this.host.newClientMessageId(),
      JSON.stringify(content),
      'LINK',
    );
    this.host.dispatch(item);
    this.dispatchLink(item, generationId);
  }

  contact(contact: Extract<ChatSendIntent, { kind: 'contact' }>): void {
    const threadId = this.host.threadId();
    if (!threadId) return;
    const source = this.host.source();
    if (!source) return;
    const cid = this.host.newClientMessageId();
    const item = this.host.makeItem(
      cid,
      JSON.stringify({
        account: contact.account,
        displayName: contact.name,
        bio: contact.bio,
      }),
      'CONTACT_CARD',
    );
    this.host.dispatch(item);
    void withSendTimeout(
      this.adapter.sendContact({
        threadId,
        target: contact.target,
        clientMessageId: cid,
        optimistic: item,
        source,
      }),
    )
      .then((response) => this.settle(response, threadId, item))
      .catch(() => void this.host.fail(item));
  }

  retryText(item: CbItem<ChatItemData>): void {
    if (!item.data.serverGap) this.dispatchText(item as CbItem<ChatMsgData>);
  }

  private dispatchText(item: CbItem<ChatMsgData>): void {
    const threadId = this.host.threadId();
    const source = this.host.source();
    if (!threadId || !source || !item.clientMessageId) return;
    const textContent = stringifyTextMessageContent({
      text: item.data.wireText ?? item.data.text,
    });
    const content =
      item.data.quote?.seq === undefined
        ? textContent
        : withMessageContentQuote(textContent, { seq: item.data.quote.seq });
    void withSendTimeout(
      this.adapter.sendText({
        threadId,
        content,
        clientMessageId: item.clientMessageId,
        optimistic: item,
        source,
      }),
    )
      .then((response) => this.settle(response, threadId, item))
      .catch(() => void this.host.fail(item));
  }

  private dispatchLink(item: CbItem<ChatMsgData>, generationId: string): void {
    const threadId = this.host.threadId();
    if (!threadId || !item.clientMessageId) return;
    void withSendTimeout(
      this.adapter.sendLink({
        threadId,
        generationId,
        clientMessageId: item.clientMessageId,
      }),
    )
      .then((response) => this.settle(response, threadId, item))
      .catch(() => void this.host.fail(item));
  }

  private settle(
    response: StandardResponse<unknown>,
    threadId: number,
    item: CbItem<ChatItemData>,
  ): void {
    if (response.code !== 0) {
      this.host.surfaceFailure(response, threadId);
      void this.host.fail(item);
    } else void this.host.accept(item);
  }
}
