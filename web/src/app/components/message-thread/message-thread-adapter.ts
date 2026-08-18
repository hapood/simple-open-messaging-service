import { inject, Injectable, InjectionToken } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type {
  CbConfig,
  ScrollerApi,
} from '../../lib/chat-box/chat-box-scroller';
import type { CbSource } from '../../lib/chat-box/cb-source';
import type { ChatItemData, MediaStatus } from '../message-cards/chat-item';
import type {
  ConversationItem,
  Message,
  StandardResponse,
} from '../../services/model';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { MsgService } from '../../services/message.service';
import { HttpItemSource } from './http-item-source';
import type {
  UploadPartIdentity,
  UploadProgressHandler,
} from '../../services/message.service';

export interface MessageThreadLiveCallbacks {
  onNewerAvailable: (seq: number) => void;
  onMediaStatus: (seq: number, status: MediaStatus) => void;
  onProfile: (
    seq: number,
    profile: {
      name: string;
      avatar: string;
      avatarIdentityId: number;
      isSelf: boolean;
    },
  ) => void;
}

/** The complete source contract consumed by the production thread shell. */
export interface MessageThreadSource extends CbSource<ChatItemData> {
  addPending(item: CbItem<ChatItemData>): void;
  pendingByClientMessageId(
    clientMessageId: string,
  ): CbItem<ChatItemData> | undefined;
  failPending(clientMessageId: string): boolean;
  retryPending(clientMessageId: string): CbItem<ChatItemData> | undefined;
  discardPending(clientMessageId: string): boolean;
  markPendingAccepted(clientMessageId: string): boolean;
  finishLocalInit?(
    liveLatestSeq: number | undefined,
    persistedLatestSeq?: number | null,
  ): void;
}

export interface SendTextRequest {
  threadId: number;
  content: string;
  clientMessageId: string;
  optimistic: CbItem<ChatItemData>;
  source: MessageThreadSource;
}

export interface ForwardMessagesRequest {
  threadId: number;
  sourceMessages: ReadonlyArray<{ threadId: number; seq: number }>;
  mode: 'DIRECT' | 'HISTORY';
  clientMessageId: string;
}

export interface SearchMessagesRequest {
  threadId: number;
  keyword: string;
  take: number;
  lastSeq?: number;
}

export interface StageMediaRequest {
  threadId: number;
  contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO' | 'GALLERY';
  clientMessageId: string;
  fileCnt?: number;
  retry?: boolean;
}

/** Runtime boundary for the production chatbox. Alternate hosts replace data and transport, never its UI. */
export abstract class MessageThreadAdapter {
  abstract createSource(
    conversation: ConversationItem,
    callbacks: MessageThreadLiveCallbacks,
  ): MessageThreadSource;

  abstract sendText(
    request: SendTextRequest,
  ): Promise<StandardResponse<unknown>>;

  abstract sendLink(request: {
    threadId: number;
    generationId: string;
    clientMessageId: string;
  }): Promise<StandardResponse<unknown>>;

  abstract searchMessages(request: SearchMessagesRequest): Observable<
    StandardResponse<{ seq: number; createdAt: number }[]> & {
      hasMore?: boolean;
    }
  >;

  abstract reportMessages(request: {
    threadId: number;
    seqs: number[];
  }): Observable<StandardResponse<unknown>>;

  abstract withdrawMessage(request: {
    threadId: number;
    seq: number;
  }): Observable<StandardResponse<unknown>>;

  abstract sendForward(
    request: ForwardMessagesRequest,
  ): Observable<StandardResponse<Message>>;

  abstract setMuted(request: {
    threadId: number;
    muted: boolean;
  }): Observable<StandardResponse>;

  abstract setBlocked(request: {
    threadId: number;
    blocked: boolean;
  }): Observable<StandardResponse>;

  abstract setPinned(request: {
    threadId: number;
    pinned: boolean;
  }): Observable<StandardResponse>;

  abstract clearHistory(request: {
    threadId: number;
  }): Observable<StandardResponse>;

  abstract stageMedia(
    request: StageMediaRequest,
  ): Observable<StandardResponse<{ clientMessageId: string }>>;

  abstract uploadPart<T>(
    file: File,
    identity: UploadPartIdentity,
    onProgress?: UploadProgressHandler,
  ): Observable<StandardResponse<T>>;

  /** Optional host-owned forwarding directory. Production uses the live conversation list. */
  forwardTargets(): readonly ConversationItem[] | undefined {
    return undefined;
  }

  /** Production reconciles the durable deletion log; in-memory hosts already mutated their source. */
  syncWithdrawalsAfterMutation(): boolean {
    return true;
  }

  scrollerConfig(): Partial<CbConfig> | undefined {
    return undefined;
  }

  configureScroller(_scroller: ScrollerApi<ChatItemData>): void {}
}

@Injectable({ providedIn: 'root' })
export class ProductionMessageThreadAdapter extends MessageThreadAdapter {
  private readonly repository = inject(MessageRepository);
  private readonly users = inject(UserService);
  private readonly outbox = inject(ThreadSendOutbox);
  private readonly profiles = inject(ProfileRepository);
  private readonly messages = inject(MsgService);

  override createSource(
    conversation: ConversationItem,
    callbacks: MessageThreadLiveCallbacks,
  ): MessageThreadSource {
    return new HttpItemSource(
      conversation,
      this.repository,
      this.users,
      this.outbox,
      callbacks,
      this.profiles,
    );
  }

  override sendText(
    request: SendTextRequest,
  ): Promise<StandardResponse<unknown>> {
    return firstValueFrom(
      this.messages.sendMessage({
        threadId: request.threadId,
        content: request.content,
        contentType: 'PURE_TEXT',
        clientMessageId: request.clientMessageId,
      }),
    );
  }

  override sendLink(request: {
    threadId: number;
    generationId: string;
    clientMessageId: string;
  }): Promise<StandardResponse<unknown>> {
    return firstValueFrom(
      this.messages.sendMessage({
        threadId: request.threadId,
        content: request.generationId,
        contentType: 'LINK',
        clientMessageId: request.clientMessageId,
      }),
    );
  }

  override searchMessages(request: SearchMessagesRequest) {
    return this.messages.searchMessages(request);
  }

  override reportMessages(request: { threadId: number; seqs: number[] }) {
    return this.messages.reportMessages(request);
  }

  override withdrawMessage(request: { threadId: number; seq: number }) {
    return this.messages.withdrawMessage(request);
  }

  override sendForward(request: ForwardMessagesRequest) {
    return this.messages.sendForward(request);
  }

  override setBlocked(request: { threadId: number; blocked: boolean }) {
    return this.messages.setBlocked(request);
  }

  override setMuted(request: { threadId: number; muted: boolean }) {
    return this.messages.setMuted(request);
  }

  override setPinned(request: { threadId: number; pinned: boolean }) {
    return this.messages.setPinned(request);
  }

  override clearHistory(request: { threadId: number }) {
    return this.messages.clearHistory(request);
  }

  override stageMedia(request: StageMediaRequest) {
    return this.messages.sendMedia(request);
  }

  override uploadPart<T>(
    file: File,
    identity: UploadPartIdentity,
    onProgress?: UploadProgressHandler,
  ) {
    return this.messages.uploadPart<T>(file, identity, onProgress);
  }
}

export const MESSAGE_THREAD_ADAPTER = new InjectionToken<MessageThreadAdapter>(
  'MESSAGE_THREAD_ADAPTER',
  { factory: () => inject(ProductionMessageThreadAdapter) },
);
