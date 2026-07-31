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
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { firstValueFrom } from 'rxjs';
import { MsgService } from '../../services/message.service';
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
import type {
  ForwardManifestMessage,
  ForwardWireBundle,
  ForwardWireClosure,
} from './forward-bundle.model';
import { ForwardSnapshotSource } from './forward-snapshot-source';
import { AppIconType, IconComponent } from '../icon/icon.component';

const CONTENT_TYPES = new Set<ChatMsgData['contentType']>([
  'PURE_TEXT',
  'INVITE',
  'IMAGE',
  'VIDEO',
  'FILE',
  'AUDIO',
  'LINK',
  'CALL',
  'FORWARD',
]);

@Component({
  selector: 'app-forward-detail',
  standalone: true,
  imports: [TranslocoPipe, IconComponent],
  templateUrl: './forward-detail.component.html',
  styleUrl: './forward-detail.component.scss',
})
export class ForwardDetailComponent implements OnInit, OnDestroy {
  readonly AppIconType = AppIconType;
  readonly bundleId = input.required<string>();
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly closure = signal<ForwardWireClosure | null>(null);
  readonly stack = signal<string[]>([]);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private readonly messages = inject(MsgService);
  private readonly route = inject(RouteService);
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly gallery = inject(GalleryViewerService);
  private readonly fileDetail = inject(FileDetailService);
  private scroller?: ChatBoxScroller<ChatItemData>;

  readonly bundleMap = computed(
    () =>
      new Map(
        (this.closure()?.bundles ?? []).map((bundle) => [bundle.id, bundle]),
      ),
  );
  readonly currentBundle = computed<ForwardWireBundle | null>(() => {
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
      this.closure.set(response.data);
      this.stack.set([response.data.rootBundleId]);
    } catch {
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
    bundle: ForwardWireBundle,
  ): void {
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
    );
  }

  private openChild(bundleId: string): void {
    if (!this.bundleMap().has(bundleId)) return;
    this.stack.update((items) => [...items, bundleId]);
  }

  private toItems(bundle: ForwardWireBundle): CbItem<ChatItemData>[] {
    const items: CbItem<ChatItemData>[] = bundle.manifest.messages.map(
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
    bundle: ForwardWireBundle,
  ): ChatMsgData {
    const contentType = CONTENT_TYPES.has(
      message.contentType as ChatMsgData['contentType'],
    )
      ? (message.contentType as ChatMsgData['contentType'])
      : 'PURE_TEXT';
    const media = parseMedia(message, id);
    const creator = stableIdentityId(
      `${message.sender.account}@${message.sender.domain}`,
    );
    return {
      type: 'msg',
      msgId: id,
      creator,
      isSelf: false,
      name: message.sender.displayName || message.sender.account,
      avatar: this.avatarUrl(message, bundle),
      avatarIdentityId: creator,
      text:
        contentType === 'PURE_TEXT'
          ? toDisplayText(message.content)
          : snapshotContent(message),
      time: dayjs(message.sentAt).format('HH:mm'),
      contentType,
      images:
        contentType === 'IMAGE' ||
        contentType === 'VIDEO' ||
        contentType === 'AUDIO'
          ? media.images
          : null,
      file: contentType === 'FILE' ? media.file : null,
      createdAtMs: message.sentAt,
    };
  }

  private avatarUrl(
    message: ForwardManifestMessage,
    bundle: ForwardWireBundle,
  ): string {
    const digest = message.sender.avatarDigest;
    if (!digest) return '';
    const asset = bundle.assets.find(
      (candidate) => candidate.kind === 'avatar' && candidate.digest === digest,
    );
    if (!asset) return '';
    return `/uploads/shards/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.${asset.extension}`;
  }
}

function parseMedia(
  message: ForwardManifestMessage,
  id: number,
): {
  images: ChatMsgData['images'];
  file: FileInfo | null;
} {
  try {
    const value = JSON.parse(message.content) as Record<string, unknown>;
    const url = typeof value['url'] === 'string' ? value['url'] : '';
    if (message.contentType === 'FILE') {
      return {
        images: null,
        file: url
          ? {
              url,
              name: String(value['name'] ?? 'file'),
              size: Number(value['size']) || 0,
              mimeType: String(value['mimeType'] ?? ''),
            }
          : null,
      };
    }
    if (
      url &&
      (message.contentType === 'IMAGE' ||
        message.contentType === 'VIDEO' ||
        message.contentType === 'AUDIO')
    ) {
      return {
        images: [
          {
            kind:
              message.contentType === 'IMAGE'
                ? 'image'
                : message.contentType === 'VIDEO'
                  ? 'video'
                  : 'audio',
            src: url,
            w: Number(value['w']) || 220,
            h: Number(value['h']) || 52,
            size: Number(value['size']) || 0,
            duration: Number(value['duration']) || 0,
            name: String(value['name'] ?? ''),
            msgId: id,
          },
        ],
        file: null,
      };
    }
  } catch {
    // A malformed snapshot remains isolated to its own fallback card.
  }
  return { images: null, file: null };
}

function snapshotContent(message: ForwardManifestMessage): string {
  if (message.contentType !== 'FORWARD' || !message.childBundleId)
    return message.content;
  try {
    const value = JSON.parse(message.content) as Record<string, unknown>;
    return JSON.stringify({ ...value, bundleId: message.childBundleId });
  } catch {
    return message.content;
  }
}

function stableIdentityId(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index += 1) {
    hash = (Math.imul(hash, 31) + identity.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) || 1;
}
