import { Injectable, signal } from '@angular/core';
import { of } from 'rxjs';
import type {
  CbConfig,
  CbItem,
  ScrollerApi,
} from '../app/lib/chat-box/chat-box-scroller';
import type {
  ChatItemData,
  ChatMsgData,
} from '../app/components/message-cards/chat-item';
import {
  createP2PConversation,
  type ConversationItem,
  type StandardResponse,
} from '../app/services/model';
import {
  MessageThreadAdapter,
  type MessageThreadLiveCallbacks,
  type MessageThreadSource,
  type ForwardMessagesRequest,
  type SearchMessagesRequest,
  type SendTextRequest,
  type SendContactRequest,
  type StageMediaRequest,
} from '../app/components/message-thread/message-thread-adapter';
import type {
  UploadPartIdentity,
  UploadProgressHandler,
} from '../app/services/message.service';
import {
  MockItemSource,
  MockUserService,
} from '../app/pages/chatbox-playground/http-item-source.mock';

@Injectable({ providedIn: 'root' })
export class PlaygroundMessageThreadAdapter extends MessageThreadAdapter {
  readonly itemCount = signal(100);
  readonly sourceLatency = signal(200);
  readonly confirmDelay = signal(800);
  readonly replyDelay = signal(800);
  readonly opponentPushCount = signal(1);
  readonly groupPushCount = signal(2);
  readonly groupSenderCount = signal(3);
  readonly sendError = signal(false);
  readonly pushSignalDelay = signal(0);
  readonly opponentInterleave = signal(false);
  readonly closeCheckpoint = signal(false);
  readonly config = signal<Required<CbConfig>>({
    edge: 1000,
    mountItem: 50,
    thresholdFloor: 6000,
    vhExtra: 2000,
    initBatch: 100,
    deferInitFill: true,
  });

  private source?: MockItemSource;
  private readonly groupSources = new WeakSet<MessageThreadSource>();
  override createSource(
    conversation: ConversationItem,
    _callbacks: MessageThreadLiveCallbacks,
  ): MessageThreadSource {
    const isGroupConversation = conversation.type === 'GROUP';
    const source = new MockItemSource(
      this.itemCount(),
      this.sourceLatency(),
      new MockUserService(),
      1,
      isGroupConversation,
      this.groupSenderCount(),
    );
    if (isGroupConversation) this.groupSources.add(source);
    this.source = source;
    return source;
  }

  override async sendText(
    request: SendTextRequest,
  ): Promise<StandardResponse<unknown>> {
    return this.sendAuthored(request);
  }

  override async sendContact(
    request: SendContactRequest,
  ): Promise<StandardResponse<unknown>> {
    return this.sendAuthored(request);
  }

  private async sendAuthored(
    request: SendTextRequest | SendContactRequest,
  ): Promise<StandardResponse<unknown>> {
    await wait(this.confirmDelay());
    if (this.sendError()) return { code: -1, message: 'Mock send failed' };

    const source = request.source as MockItemSource;
    if (request.optimistic.data.type !== 'msg') {
      throw new Error('Only authored messages can be sent optimistically');
    }
    const isGroupConversation = this.groupSources.has(request.source);
    const sentId = source.allocateMsgId();
    const sent: CbItem<ChatItemData> = {
      id: sentId,
      clientMessageId: request.clientMessageId,
      data: {
        ...request.optimistic.data,
        msgId: sentId,
        creator: JSON.stringify([0, 'mock.local', 'user-1']),
        isSelf: true,
        name: 'Me',
        // The real production source carries `sent` when the push echo wins the HTTP-response race.
        // Keeping it here lets the kernel-tagged real play the same spinner-to-check choreography.
        status: 'sent',
        kind: undefined,
        isGroupConversation,
      },
    };
    const replies = isGroupConversation
      ? this.groupPushCount()
      : this.opponentPushCount();
    const incoming = this.makeReplies(source, replies, isGroupConversation);
    void this.deliverEcho(source, sent, incoming);
    return { code: 0, message: 'ok' };
  }

  override async sendLink(request: {
    threadId: number;
    generationId: string;
    clientMessageId: string;
  }): Promise<StandardResponse<unknown>> {
    await wait(this.confirmDelay());
    if (this.sendError()) return { code: -1, message: 'Mock action failed' };
    const source = this.source;
    if (source) {
      const optimistic = source.pendingByClientMessageId(
        request.clientMessageId,
      );
      const sentId = source.allocateMsgId();
      const now = new Date();
      source.pushLive([
        {
          id: sentId,
          clientMessageId: request.clientMessageId,
          data: {
            ...(optimistic?.data as ChatMsgData | undefined),
            type: 'msg' as const,
            msgId: sentId,
            creator: JSON.stringify([0, 'mock.local', 'user-1']),
            isSelf: true,
            name: 'Me',
            text: optimistic?.data.text ?? '',
            time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
            contentType: 'LINK',
            images: null,
            file: null,
            createdAtMs: now.getTime(),
            status: 'sent',
          },
        },
      ]);
    }
    return { code: 0, message: 'ok' };
  }

  override searchMessages(request: SearchMessagesRequest) {
    const data = this.source?.search(request.keyword, request.take) ?? [];
    return of({ code: 0, message: 'ok', data, hasMore: false });
  }

  override reportMessage(_request: { threadId: number; seq: number }) {
    return of(this.mockResponse());
  }

  override withdrawMessage(request: { threadId: number; seq: number }) {
    this.source?.withdraw(request.seq);
    return of(this.mockResponse());
  }

  override sendForward(_request: ForwardMessagesRequest) {
    return of(
      this.mockResponse() as StandardResponse<
        import('../app/services/model').Message
      >,
    );
  }

  override setMuted(_request: { threadId: number; muted: boolean }) {
    return of(this.mockResponse());
  }

  override setBlocked(_request: { threadId: number; blocked: boolean }) {
    return of(this.mockResponse());
  }

  override setPinned(_request: { threadId: number; pinned: boolean }) {
    return of(this.mockResponse());
  }

  override stageMedia(request: StageMediaRequest) {
    return of({
      code: 0,
      message: 'ok',
      data: { clientMessageId: request.clientMessageId },
    });
  }

  override uploadPart<T>(
    file: File,
    _identity: UploadPartIdentity,
    onProgress?: UploadProgressHandler,
  ) {
    onProgress?.(file.size, file.size);
    const data = {
      url: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
    } as T;
    return of({ code: 0, message: 'ok', data });
  }

  override forwardTargets(): readonly ConversationItem[] {
    return [
      mockConversation(2, 'Design review', 'Maya'),
      mockConversation(3, 'Customer success', 'Noah'),
      mockConversation(4, 'Release planning', 'Olivia'),
    ];
  }

  override syncWithdrawalsAfterMutation(): boolean {
    return false;
  }

  override scrollerConfig(): Partial<CbConfig> {
    return this.config();
  }

  override configureScroller(scroller: ScrollerApi<ChatItemData>): void {
    (
      scroller as ScrollerApi<ChatItemData> & { closeCheckpoint?: boolean }
    ).closeCheckpoint = this.closeCheckpoint();
  }

  private makeReplies(
    source: MockItemSource,
    count: number,
    isGroupConversation: boolean,
  ): CbItem<ChatItemData>[] {
    const now = new Date();
    return Array.from({ length: count }, (_, index) => {
      const id = source.allocateMsgId();
      const senderOffset = isGroupConversation
        ? index % this.groupSenderCount()
        : 0;
      const data: ChatMsgData = {
        type: 'msg',
        msgId: id,
        creator: JSON.stringify([
          0,
          'mock.local',
          `user-${2 + senderOffset}`,
        ]),
        isSelf: false,
        isGroupConversation,
        name: ['Alice', 'Maya', 'Noah', 'Olivia'][senderOffset],
        text:
          index === 0
            ? 'Thanks — this reply is generated by the playground mock.'
            : `Follow-up reply ${index + 1}`,
        time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        contentType: 'PURE_TEXT',
        images: null,
        file: null,
        createdAtMs: now.getTime() + index,
      };
      return { id, data };
    });
  }

  private async deliverEcho(
    source: MockItemSource,
    sent: CbItem<ChatItemData>,
    incoming: CbItem<ChatItemData>[],
  ): Promise<void> {
    await wait(this.pushSignalDelay());
    source.pushLive(
      this.opponentInterleave() && incoming.length > 0
        ? [incoming.shift()!, sent]
        : [sent],
    );
    if (incoming.length === 0) return;
    await wait(this.replyDelay());
    source.pushLive(incoming);
  }

  private mockResponse(): StandardResponse<unknown> {
    return this.sendError()
      ? { code: -1, message: 'Mock action failed' }
      : { code: 0, message: 'ok' };
  }
}

function wait(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function mockConversation(
  threadId: number,
  alias: string,
  peerName: string,
): ConversationItem {
  return createP2PConversation(
    threadId,
    {
      id: threadId + 10,
      account: peerName.toLocaleLowerCase(),
      name: peerName,
    },
    { alias },
  );
}
