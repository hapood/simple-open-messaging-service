import {
  Component,
  computed,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  OnInit,
  OnDestroy,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import dayjs from 'dayjs';
import { defer, firstValueFrom, Subscription } from 'rxjs';
import { MsgService } from '../../services/message.service';
import { messageCreatorKey } from '../../services/model';
import { RouteService } from '../../services/route.service';
import {
  ChatBoxScroller,
  type CbElement,
  type CbWindowRequest,
  type CbItem,
} from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData, ChatMsgData } from '../message-cards/chat-item';
import {
  computeRowFlags,
  createMsgCbElement,
  createGhostCbElement,
} from '../message-cards/create-item';
import {
  absorbAlbumTail,
  mergeAlbumItemsAtBoundary,
} from '../message-cards/merge-items';
import { GalleryViewerService } from '../gallery-viewer/gallery-viewer.service';
import { toDisplayText } from '../../lib/message-entity';
import { requireTextMessageContent } from '../../../../../shared/text-message-content';
import { deriveMessagePreview } from '../../../../../shared/message-preview';
import type {
  ForwardManifestMessage,
  ForwardWireChild,
  ForwardWireBundle,
} from './forward-bundle.model';
import { ForwardSnapshotSource } from './forward-snapshot-source';
import { forwardAvatarSource } from './forward-avatar-source';
import { AppIconType, IconComponent } from '../icon/icon.component';
import { jumpToMessage } from '../message-thread/message-jump';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { projectMessageContent } from '../message-cards/media-content';

const CONTENT_TYPES = new Set<ChatMsgData['contentType']>([
  'PURE_TEXT',
  'IMAGE',
  'VIDEO',
  'FILE',
  'AUDIO',
  'GALLERY',
  'LINK',
  'CONTACT_CARD',
  'FORWARD',
]);

@Component({
  selector: 'app-forward-detail',
  standalone: true,
  imports: [TranslocoPipe, MatButtonModule, IconComponent, PageHeaderComponent],
  templateUrl: './forward-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './forward-detail.component.scss',
})
export class ForwardDetailComponent implements OnInit, OnDestroy {
  readonly AppIconType = AppIconType;
  readonly bundleId = input.required<string>();
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly closure = signal<ForwardWireBundle | null>(null);
  readonly stack = signal<string[]>([]);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private readonly messages = inject(MsgService);
  private readonly route = inject(RouteService);
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly gallery = inject(GalleryViewerService);
  private scroller?: ChatBoxScroller<ChatItemData>;
  private snapshotInitialization?: Subscription;
  private snapshotSource?: ForwardSnapshotSource;
  private snapshotItems: CbItem<ChatItemData>[] = [];
  private finishWindowJump?: (found: boolean) => void;

  readonly bundleMap = computed(() => {
    const closure = this.closure();
    if (!closure) return new Map<string, ForwardWireChild>();
    return new Map<string, ForwardWireChild>([
      [closure.id, closure],
      ...closure.children.map((bundle) => [bundle.id, bundle] as const),
    ]);
  });
  readonly currentBundle = computed<ForwardWireChild | null>(() => {
    const ids = this.stack();
    return this.bundleMap().get(ids[ids.length - 1] ?? '') ?? null;
  });
  readonly canGoBack = computed(() => this.stack().length > 1);
  readonly currentLevel = computed(() => this.stack().length);

  constructor() {
    effect(() => {
      const viewport = this.viewport()?.nativeElement;
      const content = this.content()?.nativeElement;
      const bundle = this.currentBundle();
      if (viewport && content && bundle) this.mount(viewport, content, bundle);
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    // Reuse the kernel: unbind clears the previous bundle's items and source
    // without destroying the prepared viewport infrastructure.
    this.scroller?.unbind();
    this.loading.set(true);
    this.failed.set(false);
    try {
      const response = await firstValueFrom(
        this.messages.getForwardBundle(this.bundleId()),
      );
      if (response.code !== 0 || !response.data)
        throw new Error(response.message);
      if (
        typeof response.data.id !== 'string' ||
        !Array.isArray(response.data.messages) ||
        !Array.isArray(response.data.children) ||
        !Array.isArray(response.data.assets) ||
        !response.data.accessContext
      ) {
        throw new Error('invalid forward bundle response');
      }
      this.closure.set(response.data);
      this.stack.set([response.data.id]);
    } catch (error) {
      console.error('Failed to load forwarded chat history', {
        bundleId: this.bundleId(),
        error,
      });
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    if (!this.canGoBack()) {
      this.close();
      return;
    }
    this.stack.update((items) => items.slice(0, -1));
  }

  close(): void {
    this.route.closeDlg();
  }

  ngOnDestroy(): void {
    this.closeSnapshotWindow();
    this.scroller?.destroy();
    this.scroller = undefined;
    this.snapshotItems = [];
  }

  private closeSnapshotWindow(): void {
    this.snapshotInitialization?.unsubscribe();
    this.snapshotInitialization = undefined;
    const finish = this.finishWindowJump;
    this.finishWindowJump = undefined;
    finish?.(false);
    this.scroller?.unbind();
    // The kernel owns destruction of its bound source.
    this.snapshotSource = undefined;
  }

  private mount(
    viewport: HTMLElement,
    content: HTMLElement,
    bundle: ForwardWireChild,
  ): void {
    // Nested forwarded records swap content inside the same routed dialog, so RootPopup sees no dialog
    // change. Release document-owned text selection here as well before replacing the selected nodes.
    document.getSelection()?.removeAllRanges();
    if (!this.scroller) {
      this.scroller = new ChatBoxScroller<ChatItemData>({
        viewport,
        content,
        hooks: {
          createItem: (item, prev, presentation) =>
            presentation.kind === 'message'
              ? this.createItem(item, prev)
              : createGhostCbElement(),
          mergeItems: (items) => mergeAlbumItemsAtBoundary(items, null),
          absorbTail: (target, incoming) => absorbAlbumTail(target, incoming),
        },
        config: { initBatch: 100 },
        onWindowJump: (options) => this.openSnapshotWindow(options),
      });
    }
    this.snapshotItems = this.toItems(bundle);
    void this.openSnapshotWindow({ kind: 'latest' });
  }

  private openSnapshotWindow(
    options: CbWindowRequest<ChatItemData>,
  ): Promise<boolean> {
    const kernel = this.scroller;
    if (!kernel) return Promise.resolve(false);
    this.closeSnapshotWindow();
    this.snapshotSource = new ForwardSnapshotSource(this.snapshotItems);
    kernel.bind(this.snapshotSource);
    return new Promise<boolean>((resolve) => {
      this.finishWindowJump = resolve;
      this.snapshotInitialization = defer(() =>
        kernel.openWindow(options),
      ).subscribe({
        next: () => {
          this.finishWindowJump = undefined;
          resolve(
            options.kind !== 'message' ||
              kernel.getMountedGeometry(options.messageId) !== null,
          );
        },
        error: () => {
          this.finishWindowJump = undefined;
          resolve(false);
        },
      });
    });
  }

  private createItem(
    item: CbItem<ChatItemData>,
    prev: CbItem<ChatItemData> | null,
  ): CbElement<ChatItemData> {
    const flags = computeRowFlags(item, prev);
    return createMsgCbElement(
      item,
      flags.isShowHead,
      flags.isGroupStart,
      flags.showDate,
      this.envInjector,
      (images, index) => this.gallery.open(images, index, 0),
      (data) => this.gallery.openFile(data, 0),
      undefined,
      undefined,
      (bundleId) => this.openChild(bundleId),
      (anchor) => {
        if (anchor.kind === 'local')
          void jumpToMessage(this.scroller, anchor.seq);
      },
    );
  }

  private openChild(bundleId: string): void {
    if (!this.bundleMap().has(bundleId)) return;
    this.stack.update((items) => [...items, bundleId]);
  }

  private toItems(bundle: ForwardWireChild): CbItem<ChatItemData>[] {
    const items: CbItem<ChatItemData>[] = bundle.messages.map(
      (message, index) => ({
        id: index + 1,
        data: this.toMsgData(message, index + 1, bundle),
      }),
    );
    if (items.length === 1) items[0].boundary = 'both';
    else if (items.length > 1) {
      items[0].boundary = 'oldest';
      items[items.length - 1].boundary = 'newest';
    }
    return items;
  }

  private toMsgData(
    message: ForwardManifestMessage,
    id: number,
    bundle: ForwardWireChild,
  ): ChatMsgData {
    const context = this.closure()?.accessContext;
    const snapshotMessage = context
      ? {
          ...message,
          content: bindSnapshotCasUrls(
            message.content,
            context.threadId,
            context.seq,
          ),
        }
      : message;
    const hasKnownContentType = CONTENT_TYPES.has(
      snapshotMessage.contentType as ChatMsgData['contentType'],
    );
    const contentType = hasKnownContentType
      ? (message.contentType as ChatMsgData['contentType'])
      : 'PURE_TEXT';
    // A snapshot has no author identity. Never merge rows by display name or avatar.
    const creator = JSON.stringify([bundle.id, message.id]);
    const quoteTarget = message.quoteTargetId
      ? bundle.messages.find(
          (candidate) => candidate.id === message.quoteTargetId,
        )
      : undefined;
    if (contentType === 'SYSTEM') {
      return {
        type: 'system',
        msgId: id,
        isSelf: false,
        name: '',
        text: this.snapshotContent(snapshotMessage),
        time: dayjs(message.sentAt).format('HH:mm'),
        contentType: 'SYSTEM',
        images: null,
        file: null,
        createdAtMs: message.sentAt,
      };
    }
    return {
      type: 'msg',
      msgId: id,
      creator,
      isSelf: false,
      name: message.profile.displayName,
      senderDisplayContext: 'forward',
      sender: forwardAvatarSource(message.profile, this.closure()),
      avatarIdentityId: creator,
      text:
        hasKnownContentType && contentType === 'PURE_TEXT'
          ? toDisplayText(
              requireTextMessageContent(snapshotMessage.content).text,
            )
          : this.snapshotContent(snapshotMessage),
      time: dayjs(message.sentAt).format('HH:mm'),
      ...projectMessageContent(contentType, snapshotMessage.content, {
        msgId: id,
        senderName: message.profile.displayName,
        sentAt: message.sentAt,
      }),
      createdAtMs: message.sentAt,
      quote: quoteTarget
        ? {
            kind: 'snapshot',
            author: quoteTarget.profile.displayName,
            body: snapshotPreview(quoteTarget),
          }
        : message.quoteTargetId !== undefined
          ? { kind: 'unavailable', seq: 0, status: 'NOT_FOUND' }
          : undefined,
    };
  }

  private snapshotContent(message: ForwardManifestMessage): string {
    if (message.contentType !== 'FORWARD' || !message.childBundleId) {
      return message.content;
    }
    const child = this.closure()?.children.find(
      (candidate) => candidate.id === message.childBundleId,
    );
    if (!child) return message.content;

    const bundles = new Map(
      this.closure()?.children.map((bundle) => [bundle.id, bundle] as const),
    );
    const visiting = new Set<string>();
    const summaries = new Map<
      string,
      { messageCount: number; messages: ForwardManifestMessage[] }
    >();
    const collect = (
      bundle: ForwardWireChild,
    ): { messageCount: number; messages: ForwardManifestMessage[] } => {
      if (visiting.has(bundle.id))
        throw new Error('forward bundle dependency cycle');
      const known = summaries.get(bundle.id);
      if (known) return known;
      visiting.add(bundle.id);
      let messageCount = bundle.messages.length;
      const messages: ForwardManifestMessage[] = [];
      for (const item of bundle.messages) {
        if (messages.length < 2) messages.push(item);
        if (item.childBundleId) {
          const nested = bundles.get(item.childBundleId);
          if (nested) {
            const child = collect(nested);
            messageCount += child.messageCount;
            messages.push(...child.messages.slice(0, 2 - messages.length));
          }
        }
      }
      visiting.delete(bundle.id);
      const result = { messageCount, messages };
      summaries.set(bundle.id, result);
      return result;
    };
    const { messageCount, messages } = collect(child);
    return JSON.stringify({
      bundleId: child.id,
      summaryLines: messages
        .slice(0, 2)
        .map(
          (item) =>
            `${item.profile.displayName}：${deriveMessagePreview(
              item.contentType,
              item.content,
              toDisplayText,
            )}`,
        ),
      messageCount,
    });
  }
}

function snapshotPreview(message: ForwardManifestMessage): string {
  if (message.contentType === 'PURE_TEXT') {
    return toDisplayText(requireTextMessageContent(message.content).text);
  }
  if (message.contentType === 'CONTACT_CARD') {
    try {
      const card = JSON.parse(message.content) as { displayName?: unknown };
      return typeof card.displayName === 'string'
        ? `[Contact] ${card.displayName}`
        : '[Contact]';
    } catch {
      return '[Contact]';
    }
  }
  return message.contentType;
}

function bindSnapshotCasUrls(
  content: string,
  threadId: number,
  seq: number,
): string {
  return content.replace(
    /\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}/g,
    (url) => `${url}?threadId=${threadId}&seq=${seq}`,
  );
}
