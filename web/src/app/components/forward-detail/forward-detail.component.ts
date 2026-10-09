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
import { firstValueFrom } from 'rxjs';
import { MsgService } from '../../services/message.service';
import { messageCreatorKey } from '../../services/model';
import { RouteService } from '../../services/route.service';
import {
  ChatBoxScroller,
  type CbElement,
  type CbItem,
} from '../../lib/chat-box/chat-box-scroller';
import type {
  ChatItemData,
  ChatMsgData,
  FileInfo,
} from '../message-cards/chat-item';
import {
  computeRowFlags,
  createMsgCbElement,
} from '../message-cards/create-item';
import {
  absorbAlbumTail,
  mergeAlbumItemsAtBoundary,
} from '../message-cards/merge-items';
import { GalleryViewerService } from '../gallery-viewer/gallery-viewer.service';
import { FileDetailService } from '../file-detail-viewer/file-detail-viewer.service';
import { toDisplayText } from '../../lib/message-entity';
import { requireTextMessageContent } from '../../../../../shared/text-message-content';
import { deriveMessagePreview } from '../../../../../shared/message-preview';
import type {
  ForwardManifestMessage,
  ForwardWireChild,
  ForwardWireBundle,
} from './forward-bundle.model';
import { ForwardSnapshotSource } from './forward-snapshot-source';
import { AppIconType, IconComponent } from '../icon/icon.component';
import { jumpToMessage } from '../message-thread/message-jump';
import { PageHeaderComponent } from '../page-header/page-header.component';
import {
  parseAudioContent,
  parseFileContent,
  parseGalleryContent,
  parseImageContent,
  parseVideoContent,
  type MediaUrlResolver,
} from '../message-cards/media-content';

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
  private readonly fileDetail = inject(FileDetailService);
  private scroller?: ChatBoxScroller<ChatItemData>;

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
    this.scroller?.destroy();
    this.scroller = undefined;
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
    this.scroller?.destroy();
  }

  private mount(
    viewport: HTMLElement,
    content: HTMLElement,
    bundle: ForwardWireChild,
  ): void {
    // Nested forwarded records swap content inside the same routed dialog, so RootPopup sees no dialog
    // change. Release document-owned text selection here as well before replacing the selected nodes.
    document.getSelection()?.removeAllRanges();
    this.scroller?.destroy();
    content.replaceChildren();
    const source = new ForwardSnapshotSource(this.toItems(bundle));
    this.scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      source,
      hooks: {
        createItem: (item, prev) => this.createItem(item, prev),
        mergeItems: (items) => mergeAlbumItemsAtBoundary(items, null),
        absorbTail: (target, incoming) => absorbAlbumTail(target, incoming),
      },
      config: { initBatch: 100 },
    });
    void this.scroller.init();
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
      undefined,
      (images, index) => this.gallery.open(images, index, 0),
      (data) => this.fileDetail.open(data, 0),
      undefined,
      undefined,
      undefined,
      (bundleId) => this.openChild(bundleId),
      (id) => void jumpToMessage(this.scroller, id),
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
    const media = parseMedia(snapshotMessage, id, this.snapshotMediaUrl);
    const creator = JSON.stringify([
      bundle.id,
      message.author.domain,
      message.author.account,
    ]);
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
      name: message.profile?.displayName || message.author.account,
      snapshotAvatarUrl: this.avatarUrl(message),
      avatarIdentityId: creator,
      avatarAccount: message.author.account,
      avatarDomain: message.author.domain,
      avatarDomainSource: { type: 'snapshot', domain: message.author.domain },
      text:
        hasKnownContentType && contentType === 'PURE_TEXT'
          ? toDisplayText(
              requireTextMessageContent(snapshotMessage.content).text,
            )
          : this.snapshotContent(snapshotMessage),
      time: dayjs(message.sentAt).format('HH:mm'),
      contentType,
      images:
        contentType === 'IMAGE' ||
        contentType === 'VIDEO' ||
        contentType === 'AUDIO' ||
        contentType === 'GALLERY'
          ? media.images
          : null,
      file: contentType === 'FILE' ? media.file : null,
      createdAtMs: message.sentAt,
      quote: quoteTarget
        ? {
            author:
              quoteTarget.profile?.displayName || quoteTarget.author.account,
            body: snapshotPreview(quoteTarget),
            seq: message.quoteTargetId,
          }
        : message.quoteTargetId !== undefined
          ? { seq: 0, status: 'NOT_FOUND' }
          : undefined,
    };
  }

  private readonly snapshotMediaUrl: MediaUrlResolver = (item) => {
    const existing = typeof item['url'] === 'string' ? item['url'] : '';
    if (existing) return existing;
    const digest = typeof item['digest'] === 'string' ? item['digest'] : '';
    const context = this.closure()?.accessContext;
    if (!/^[a-f0-9]{64}$/.test(digest) || !context) return '';
    return `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}?threadId=${context.threadId}&seq=${context.seq}`;
  };

  private snapshotContent(message: ForwardManifestMessage): string {
    if (message.contentType !== 'FORWARD' || !message.childBundleId) {
      return message.content;
    }
    const child = this.closure()?.children.find(
      (candidate) => candidate.id === message.childBundleId,
    );
    if (!child) return message.content;

    const seen = new Set<string>();
    const messages: ForwardManifestMessage[] = [];
    const collect = (bundle: ForwardWireChild): void => {
      if (seen.has(bundle.id)) return;
      seen.add(bundle.id);
      for (const item of bundle.messages) {
        messages.push(item);
        if (item.childBundleId) {
          const nested = this.closure()?.children.find(
            (candidate) => candidate.id === item.childBundleId,
          );
          if (nested) collect(nested);
        }
      }
    };
    collect(child);
    return JSON.stringify({
      bundleId: child.id,
      summaryLines: messages
        .slice(0, 2)
        .map(
          (item) =>
            `${item.profile?.displayName || item.author.account}：${deriveMessagePreview(
              item.contentType,
              item.content,
              toDisplayText,
            )}`,
        ),
      messageCount: messages.length,
    });
  }

  private avatarUrl(message: ForwardManifestMessage): string {
    const digest = message.profile?.avatarDigest;
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return '';
    const closure = this.closure();
    if (!closure?.assets.some((asset) => asset.digest === digest)) return '';
    const context = closure.accessContext;
    if (!context) return '';
    return `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}?threadId=${context.threadId}&seq=${context.seq}`;
  }
}

function parseMedia(
  message: ForwardManifestMessage,
  id: number,
  resolveUrl: MediaUrlResolver,
): {
  images: ChatMsgData['images'];
  file: FileInfo | null;
} {
  if (message.contentType === 'FILE')
    return {
      images: null,
      file: parseFileContent(message.content, resolveUrl),
    };
  const parsed =
    message.contentType === 'IMAGE'
      ? [parseImageContent(message.content, resolveUrl)]
      : message.contentType === 'VIDEO'
        ? [parseVideoContent(message.content, resolveUrl)].filter(
            (item): item is NonNullable<typeof item> => item !== null,
          )
        : message.contentType === 'AUDIO'
          ? [parseAudioContent(message.content, resolveUrl)].filter(
              (item): item is NonNullable<typeof item> => item !== null,
            )
          : message.contentType === 'GALLERY'
            ? parseGalleryContent(message.content, resolveUrl)
            : [];
  if (parsed.length > 0)
    return {
      images: parsed.map((item) => ({ ...item, msgId: id })),
      file: null,
    };
  return { images: null, file: null };
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
    /\/uploads\/(?:cas|msg-assets)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}/g,
    (url) => `${url}?threadId=${threadId}&seq=${seq}`,
  );
}
