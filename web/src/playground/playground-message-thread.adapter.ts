import { inject, Injectable, signal } from '@angular/core';
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
  mockSender,
} from '../app/pages/chatbox-playground/http-item-source.mock';
import {
  PlaygroundLiveMessage,
  PlaygroundSocialState,
  sameIdentity,
} from './playground-social-state';
import {
  toDisplayText,
  toRenderMessageEntities,
} from '../app/lib/message-entity';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../../shared/text-message-content';

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

  private readonly sources = new Map<number, MockItemSource>();
  private readonly groupSources = new WeakSet<MessageThreadSource>();
  private readonly state = inject(PlaygroundSocialState);

  constructor() {
    super();
    // Live ticker messages reach an open thread through the source; the
    // conversation-list commit already happened in the shared state.
    this.state.groupLive$.subscribe((event) =>
      this.deliverLiveGroupMessage(event),
    );
  }

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
    this.sources.set(conversation.threadId, source);
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
        isSelf: true,
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
    this.commitSentMessage(request);
    void this.deliverEcho(request.threadId, source, sent, incoming);
    return { code: 0, message: 'ok' };
  }

  override async sendLink(request: {
    threadId: number;
    generationId: string;
    clientMessageId: string;
  }): Promise<StandardResponse<unknown>> {
    await wait(this.confirmDelay());
    if (this.sendError()) return { code: -1, message: 'Mock action failed' };
    const source = this.sources.get(request.threadId);
    const optimistic = source?.pendingByClientMessageId(
      request.clientMessageId,
    );
    if (source && optimistic?.data.type === 'msg') {
      const sentId = source.allocateMsgId();
      const now = new Date();
      source.pushLive([
        {
          id: sentId,
          clientMessageId: request.clientMessageId,
          data: {
            ...optimistic.data,
            type: 'msg' as const,
            msgId: sentId,
            isSelf: true,
            text: optimistic.data.text,
            time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
            contentType: 'LINK',
            images: null,
            file: null,
            createdAtMs: now.getTime(),
            status: 'sent',
          },
        },
      ]);
      if (optimistic.data.text) {
        this.state.commitMessage(request.threadId, {
          senderAccount: this.state.self.account,
          senderNamespaceId: 0,
          contentType: 'LINK',
          content: optimistic.data.text,
          createdAtMs: now.getTime(),
          isSelf: true,
        });
      }
    }
    return { code: 0, message: 'ok' };
  }

  override searchMessages(request: SearchMessagesRequest) {
    const data =
      this.sources
        .get(request.threadId)
        ?.search(request.keyword, request.take) ?? [];
    return of({ code: 0, message: 'ok', data, hasMore: false });
  }

  override reportMessage(_request: { threadId: number; seq: number }) {
    return of(this.mockResponse());
  }

  override withdrawMessage(request: { threadId: number; seq: number }) {
    this.sources.get(request.threadId)?.withdraw(request.seq);
    return of({ code: 0, message: 'ok' });
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

  override queryMediaStages(_threadId: number) {
    return of({ code: 0, message: 'ok', data: [] });
  }

  override cancelUploadBatch(clientMessageId: string) {
    return of({
      code: 0,
      message: 'ok',
      data: { clientMessageId, cancelled: 1 },
    });
  }

  override sendCompletedUploadBatch(clientMessageId: string) {
    return of({
      code: 0,
      message: 'ok',
      data: { clientMessageId, sent: true, completed: 1 },
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
        creator: JSON.stringify([0, `user-${2 + senderOffset}`]),
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
    threadId: number,
    source: MockItemSource,
    sent: CbItem<ChatItemData>,
    incoming: CbItem<ChatItemData>[],
  ): Promise<void> {
    await wait(this.pushSignalDelay());
    const interleaved =
      this.opponentInterleave() && incoming.length > 0
        ? incoming.shift()!
        : null;
    source.pushLive(interleaved ? [interleaved, sent] : [sent]);
    if (interleaved) this.commitIncoming(threadId, interleaved.data);
    if (incoming.length === 0) return;
    await wait(this.replyDelay());
    source.pushLive(incoming);
    for (const item of incoming) this.commitIncoming(threadId, item.data);
  }

  /** Replies update the thread list like committed feed rows: preview, unread,
   *  and feed order advance together. Display text is wrapped back into the
   *  persisted PURE_TEXT envelope so previews use the production shape. */
  private commitIncoming(threadId: number, data: ChatItemData): void {
    if (data.type !== 'msg') return;
    const thread = this.state.conversations
      .items()
      .find((item) => item.threadId === threadId);
    if (!thread) return;
    const senderAccount =
      thread.type === 'P2P'
        ? thread.account
        : (data.name?.toLowerCase() ?? thread.account);
    this.state.commitMessage(threadId, {
      senderAccount,
      senderNamespaceId: thread.publisherNamespaceId,
      contentType: data.contentType ?? 'PURE_TEXT',
      content: stringifyTextMessageContent({ text: data.text }),
      createdAtMs: data.createdAtMs,
      isSelf: false,
    });
  }

  /** Commit the confirmed optimistic row: PURE_TEXT carries the wire envelope
   *  from the send request; CONTACT_CARD/LINK keep their persisted JSON bodies. */
  private commitSentMessage(
    request: SendTextRequest | SendContactRequest,
  ): void {
    const data = request.optimistic.data;
    if (data.type !== 'msg') return;
    const contentType = data.contentType;
    const content =
      contentType === 'PURE_TEXT' && 'content' in request
        ? request.content
        : data.text;
    this.state.commitMessage(request.threadId, {
      senderAccount: this.state.self.account,
      senderNamespaceId: 0,
      contentType,
      content,
      createdAtMs: Date.now(),
      isSelf: true,
    });
  }

  /** Render one live ticker message into the open group thread, reusing the
   *  production mention parser for segments and viewer-relative state. */
  private deliverLiveGroupMessage(event: PlaygroundLiveMessage): void {
    const source = this.sources.get(event.threadId);
    if (!source) return;
    const id = source.allocateMsgId();
    const body =
      event.contentType === 'PURE_TEXT'
        ? (parseTextMessageContent(event.content)?.text ?? '')
        : event.content;
    const rendered = toRenderMessageEntities(body, {
      account: this.state.self.account,
      namespaceId: 0,
    });
    const at = new Date(event.createdAtMs);
    source.pushLive([
      {
        id,
        data: {
          type: 'msg',
          msgId: id,
          creator: event.sender.identityKey,
          isSelf: sameIdentity(event.sender, this.state.self),
          isGroupConversation: true,
          name: event.sender.name,
          // Live pushes are authored under real playground accounts, which the
          // source's synthetic `user-N` profile table cannot resolve; without a
          // sender the shaping fallback would render "Unknown". Mirror
          // production toMsgData: attach the roster member's revision-backed
          // sender so the shared pipeline resolves name and avatar.
          sender: mockSender(event.sender, event.sender.name),
          text: toDisplayText(body),
          textSegments: rendered.segments,
          mentionState: rendered.mentionState,
          time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
          contentType: 'PURE_TEXT',
          images: null,
          file: null,
          createdAtMs: event.createdAtMs,
        },
      },
    ]);
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
  return createP2PConversation({
    threadId,
    account: peerName.toLocaleLowerCase(),
    publisherNamespaceId: 0,
    profileRev: 1,
    profile: { name: peerName, bio: '', avatarDigest: null },
    alias,
  });
}
