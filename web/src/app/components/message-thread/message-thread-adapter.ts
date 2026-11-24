import { inject, Injectable, InjectionToken } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type {
  CbConfig,
  ScrollerApi,
} from '../../lib/chat-box/chat-box-scroller';
import type { CbDemand, CbSource } from '../../lib/chat-box/cb-source';
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
} from '../../services/upload-transport';
import type { StoredNonMediaSendContent } from '../../services/send-outbox-storage';
import type {
  MountedMessageDeletionStore,
  MessageDeletionFact,
} from './mounted-message-deletion';
import type { HistoryAnchor } from '../../services/history-anchor';
import type { PreparedMessageEntry } from './message-entry';

export interface MessageThreadLiveCallbacks {
  onQuoteDeleted?: (replySeq: number, targetSeq: number) => void;
  onQuoteUpdated?: (
    replySeq: number,
    quote: import('../message-cards/chat-item').ChatMsgData['quote'],
  ) => void;
  onNewerAvailable: (seq: number, previousLatestSeq?: number) => void;
}

/** The complete source contract consumed by the production thread shell. */
export interface MessageThreadSource extends CbSource<ChatItemData> {
  prepareEntry(): Promise<PreparedMessageEntry>;
  /** Optional for alternate offline/demo sources; production resolves through the repository. */
  resolveHistoryAnchor?(
    anchor: HistoryAnchor,
    signal?: AbortSignal,
  ): Promise<number | null>;
  mountQuote?(
    replySeq: number,
    quote: NonNullable<
      import('../message-cards/chat-item').ChatMsgData['quote']
    >,
  ): () => void;
  finishLocalInit?(
    liveLatestSeq: number | undefined,
    persistedLatestSeq?: number | null,
  ): void;
  pauseLiveUpdates?(): void;
  resumeLiveUpdates?(latestSeq?: number): void;
  refreshLatest?(latestSeq: number): void;
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
}

/** Runtime boundary for the production chatbox. Alternate hosts replace data and transport, never its UI. */
export abstract class MessageThreadAdapter
  implements MountedMessageDeletionStore
{
  abstract readonly deletedLive$: MountedMessageDeletionStore['deletedLive$'];
  abstract getMessageDeletions(
    threadId: number,
    seqs: number[],
  ): Promise<MessageDeletionFact[]>;

  abstract createSource(
    conversation: ConversationItem,
    entryReadSeq: number,
    callbacks: MessageThreadLiveCallbacks,
  ): MessageThreadSource;

  abstract sendIntent(task: { clientMessageId: string; threadId: number; item: StoredNonMediaSendContent }): Promise<StandardResponse<unknown>>;

  abstract searchMessages(request: SearchMessagesRequest): Observable<
    StandardResponse<{ seq: number; createdAt: number }[]> & {
      hasMore?: boolean;
    }
  >;

  abstract reportMessage(request: {
    threadId: number;
    seq: number;
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

  abstract stageMedia(
    request: StageMediaRequest,
  ): Observable<StandardResponse<{ clientMessageId: string }>>;

  abstract cancelUploadBatch(
    clientMessageId: string,
  ): Observable<
    StandardResponse<{ clientMessageId: string; cancelled: number }>
  >;

  abstract sendCompletedUploadBatch(clientMessageId: string): Observable<
    StandardResponse<{
      clientMessageId: string;
      sent: boolean;
      completed: number;
    }>
  >;

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
class ProductionMessageThreadAdapter extends MessageThreadAdapter {
  private readonly repository = inject(MessageRepository);
  readonly deletedLive$ = this.repository.deletedLive$;

  override getMessageDeletions(threadId: number, seqs: number[]) {
    return this.repository.getMessageDeletions(threadId, seqs);
  }

  private readonly users = inject(UserService);
  private readonly outbox = inject(ThreadSendOutbox);
  private readonly profiles = inject(ProfileRepository);
  private readonly messages = inject(MsgService);

  override createSource(
    conversation: ConversationItem,
    entryReadSeq: number,
    callbacks: MessageThreadLiveCallbacks,
  ): MessageThreadSource {
    return new HttpItemSource(
      conversation,
      entryReadSeq,
      this.repository,
      this.users,
      this.outbox,
      callbacks,
      this.messages,
      this.profiles,
    );
  }

  override sendIntent(task: { clientMessageId: string; threadId: number; item: StoredNonMediaSendContent }): Promise<StandardResponse<unknown>> {
    return firstValueFrom(this.messages.sendIntent(task));
  }

  override searchMessages(request: SearchMessagesRequest) {
    return this.messages.searchMessages(request);
  }

  override reportMessage(request: { threadId: number; seq: number }) {
    return this.messages.reportMessage(request);
  }

  override withdrawMessage(request: { threadId: number; seq: number }) {
    return this.messages.withdrawMessage(request);
  }

  override sendForward(request: ForwardMessagesRequest) {
    return this.messages.sendIntent({
      clientMessageId: request.clientMessageId,
      threadId: request.threadId,
      item: { type: 'FORWARD', sourceMessages: [...request.sourceMessages], mode: request.mode },
    });
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

  override stageMedia(request: StageMediaRequest) {
    return this.messages.sendMedia(request);
  }

  override cancelUploadBatch(clientMessageId: string) {
    return this.messages.cancelUploadBatch(clientMessageId);
  }

  override sendCompletedUploadBatch(clientMessageId: string) {
    return this.messages.sendCompletedUploadBatch(clientMessageId);
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
