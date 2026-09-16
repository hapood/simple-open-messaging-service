import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatSendIntent } from '../../lib/chat-input/chat-input.component';
import {
  toDisplayText,
  toRenderMessageEntities,
} from '../../lib/message-entity';
import { stringifyTextMessageContent } from '../../../../../shared/text-message-content';
import type { LinkCardContent } from '../../services/link-card-generation.service';
import type { StandardResponse } from '../../services/model';
import type { ChatItemData, ChatMsgData } from '../message-cards/chat-item';
import type {
  MessageThreadAdapter,
  MessageThreadSource,
} from './message-thread-adapter';

export interface ThreadMessageSendHost {
  threadId(): number | undefined;
  selfAccount(): string | undefined;
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
    const rendered = toRenderMessageEntities(trimmed, this.host.selfAccount());
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
        domain: contact.domain,
        displayName: contact.name,
        bio: contact.bio,
        ...(contact.avatar ? { avatar: contact.avatar } : {}),
      }),
      'CONTACT_CARD',
    );
    this.host.dispatch(item);
    void this.adapter
      .sendContact({
        threadId,
        ...(contact.targetGroupId !== undefined
          ? { targetGroupId: contact.targetGroupId }
          : { targetUserId: contact.targetUserId }),
        clientMessageId: cid,
        optimistic: item,
        source,
      })
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
    this.adapter
      .sendText({
        threadId,
        content: stringifyTextMessageContent({
          text: item.data.wireText ?? item.data.text,
          ...(item.data.quote?.seq !== undefined
            ? { quote: { seq: item.data.quote.seq } }
            : {}),
        }),
        clientMessageId: item.clientMessageId,
        optimistic: item,
        source,
      })
      .then((response) => this.settle(response, threadId, item))
      .catch(() => void this.host.fail(item));
  }

  private dispatchLink(item: CbItem<ChatMsgData>, generationId: string): void {
    const threadId = this.host.threadId();
    if (!threadId || !item.clientMessageId) return;
    this.adapter
      .sendLink({
        threadId,
        generationId,
        clientMessageId: item.clientMessageId,
      })
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
