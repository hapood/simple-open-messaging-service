import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { ProfileNamespaceRepository } from './profile-namespace-store.service';
import { namespaceDisplayDomain } from './profile-namespace-domain';
import { ConversationListService } from './conversation-list.service';
import {
  apiOrigin,
  isAndroidNative,
  isTauri,
  listenEvent,
  tauriInvoke,
} from './runtime';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationAdapter } from './notification-adapter';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG, parseSwNotifMessage } from './sw-notif-protocol';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  threadNotificationDescriptor,
  type ThreadNotificationUpdate,
} from './thread-notification';
import { WebdbService } from './webdb.service';
import { WebPushService } from './web-push.service';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';
import { uuid } from '../lib/uuid';

/** Browser: bridge worker-projected updates to the push service worker, and answer active-chat
 * queries. Android sends only the selected chat to native; Rust projects its notifications. */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly prefs = inject(NotificationPrefsService);
  private readonly nav = inject(NavStateMachineService);
  private readonly navigation = inject(ThreadNavigationIntentService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly i18n = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly webdb = inject(WebdbService);
  private readonly namespaces = inject(ProfileNamespaceRepository);
  private readonly webPush = inject(WebPushService);
  private readonly baseTitle =
    typeof document !== 'undefined' ? document.title : 'SOMS';
  private readonly focused = signal(true);
  private readonly unreadTotal = computed(() =>
    this.convList.items().reduce((sum, item) => sum + item.unreadCount, 0),
  );
  private queue = Promise.resolve();
  private generation = 0;
  private desktopSince = 0;
  private navigationQueue: Promise<void> = Promise.resolve();
  private readonly adapter!: BrowserNotificationAdapter | NotificationAdapter;
  private readonly nativeAdapter?: TauriNotificationAdapter;

  constructor() {
    if (typeof document === 'undefined') return;
    if (isAndroidNative()) {
      effect(() => {
        const threadId =
          this.nav.topSection() === 'chats'
            ? (this.nav.chatThreadId() ?? -1)
            : -1;
        window.SomsFcm!.setActiveThreadId(threadId);
      });
      this.lifecycle.invalidated$
        .pipe(takeUntilDestroyed())
        .subscribe(() => window.SomsFcm!.setActiveThreadId(-1));
      this.destroyRef.onDestroy(() => window.SomsFcm?.setActiveThreadId(-1));
      return;
    }
    if (isTauri()) this.nativeAdapter = new TauriNotificationAdapter();
    this.adapter = this.nativeAdapter ?? new BrowserNotificationAdapter();
    if (isTauri()) this.installDesktopNavigation();
    const blur = () => this.onFocusChange(false);
    const focus = () => this.onFocusChange(true);
    const visibility = () =>
      this.onFocusChange(document.visibilityState === 'visible');
    const message = (event: MessageEvent) => this.onSwMessage(event);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    navigator.serviceWorker?.addEventListener('message', message);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
      navigator.serviceWorker?.removeEventListener('message', message);
      // Closing the app is not logout. Stop pending page work, but leave
      // system notifications and their activation receipts available.
      this.generation++;
      this.nativeAdapter?.dispose();
    });
    effect(() => {
      const threadId =
        this.nav.topSection() === 'chats' ? this.nav.chatThreadId() : undefined;
      if (this.focused() && threadId !== undefined)
        void this.adapter.clearThread(threadId);
    });
    effect(() => {
      const count = this.unreadTotal();
      document.title =
        count > 0 && !this.focused()
          ? `(${count}) ${this.baseTitle}`
          : this.baseTitle;
    });
    this.lifecycle.invalidated$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.dismissActive());
    if (!isTauri()) {
      this.webdb.browserNotifications$
        .pipe(takeUntilDestroyed())
        .subscribe(({ userId, entries }) => {
          const epoch = this.lifecycle.accountEpoch;
          void this.webPush
            .worker()
            .then((registration) => {
              if (this.lifecycle.isCurrent(epoch))
                registration?.active?.postMessage({
                  type: SOMS_NOTIF_MSG.PRESENT,
                  userId,
                  entries,
                });
            })
            .catch((error) =>
              console.warn('[notification] worker unavailable', error),
            );
        });
    } else {
      this.convList.threadNotifications$
        .pipe(takeUntilDestroyed())
        .subscribe((updates) => {
          const epoch = this.lifecycle.accountEpoch;
          const generation = this.generation;
          const activeChat =
            this.focused() && this.nav.topSection() === 'chats'
              ? this.nav.chatThreadId()
              : undefined;
          this.queue = this.queue
            .then(() => this.present(updates, epoch, generation, activeChat))
            .catch(() => {});
        });
    }
  }

  private installDesktopNavigation(): void {
    let destroyed = false;
    let unlisten: (() => void) | undefined;
    this.destroyRef.onDestroy(() => {
      destroyed = true;
      unlisten?.();
    });
    const consume = () => {
      const epoch = this.lifecycle.accountEpoch;
      this.navigationQueue = this.navigationQueue
        .then(async () => {
          if (destroyed || !this.lifecycle.isCurrent(epoch)) return;
          const tap = await tauriInvoke<{
            id: string;
            threadId: number;
            sessionId: number;
            origin: string;
          } | null>('desktop_notification_pending');
          if (
            !tap ||
            destroyed ||
            !this.lifecycle.isCurrent(epoch) ||
            typeof tap.id !== 'string' ||
            !tap.id.trim() ||
            !Number.isSafeInteger(tap.threadId) ||
            tap.threadId <= 0 ||
            !Number.isSafeInteger(tap.sessionId) ||
            tap.sessionId <= 0 ||
            !tap.origin ||
            tap.origin !== apiOrigin()
          )
            return;
          this.navigation.offer(
            {
              source: 'desktop',
              id: tap.id,
              threadId: tap.threadId,
              sessionId: tap.sessionId,
              acknowledge: () =>
                tauriInvoke<void>('desktop_notification_acknowledge', tap),
            },
            epoch,
          );
        })
        .catch((error) =>
          console.warn('[notification] desktop navigation failed', error),
        );
    };
    void listenEvent('desktop-notification-open', consume)
      .then((stop) => {
        if (destroyed) {
          stop?.();
          return;
        }
        unlisten = stop;
        consume();
      })
      .catch((error) =>
        console.warn('[notification] desktop listener failed', error),
      );
  }

  private onFocusChange(focused: boolean): void {
    this.focused.set(focused);
    if (focused) {
      // Invalidate native renders queued while the app was away.
      this.generation++;
      // The reactive open-chat effect dismisses only the chat now displayed.
    }
  }

  private dismissActive(): void {
    this.generation++;
    this.desktopSince = 0;
    void this.adapter.clear();
  }

  private onSwMessage(event: MessageEvent): void {
    if (event.data?.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST) {
      event.ports[0]?.postMessage({
        threadId:
          this.focused() && this.nav.topSection() === 'chats'
            ? this.nav.chatThreadId()
            : undefined,
      });
      return;
    }
    const data = parseSwNotifMessage(event.data);
    if (!data) return;
    if (
      data.type === SOMS_NOTIF_MSG.COMMITTED &&
      typeof data.userId === 'number'
    ) {
      void this.convList.refreshBackgroundThreadFeed(data.userId);
    } else if (
      data.type === SOMS_NOTIF_MSG.OPEN &&
      typeof data.threadId === 'number'
    ) {
      window.focus();
      this.navigation.offer({
        source: 'web',
        id: uuid(),
        threadId: data.threadId,
        sessionId: data.sessionId,
      });
    }
  }

  private async present(
    batch: ThreadNotificationUpdate[],
    epoch: number,
    generation: number,
    activeChat: number | undefined,
  ): Promise<void> {
    const run = async () => {
      if (!this.lifecycle.isCurrent(epoch)) return;
      const after = this.desktopSince;
      if (!this.lifecycle.isCurrent(epoch)) return;
      const fresh = batch.filter((update) => update.state.threadFeedId > after);
      const end = Math.max(
        after,
        ...fresh.map((update) => update.state.threadFeedId),
      );
      for (const update of fresh) {
        if (!this.lifecycle.isCurrent(epoch)) return;
        if (generation !== this.generation || !this.prefs.enabled()) break;
        if (
          update.item.threadId === activeChat &&
          this.focused() &&
          this.nav.topSection() === 'chats' &&
          this.nav.chatThreadId() === activeChat
        )
          continue;
        const subject =
          update.item.type === 'GROUP'
            ? update.item.group
            : update.item.peerUser;
        const binding = await firstValueFrom(
          this.namespaces.resolve({
            publisherNamespaceId: 0,
            profileNamespaceId: subject.namespaceId,
          }),
        );
        if (generation !== this.generation || !this.lifecycle.isCurrent(epoch))
          break;
        const descriptor = threadNotificationDescriptor(
          update,
          this.prefs.previewMode(),
          {
            lang: this.i18n.getActiveLang(),
            privateBody: this.i18n.translate('settings.notifNewMessage'),
            retracted: '[' + this.i18n.translate('chat.messageRetracted') + ']',
            removed:
              '[' + this.i18n.translate('chat.messageRemovedByAdmin') + ']',
          },
          namespaceDisplayDomain(binding),
        );
        descriptor.silent = !!descriptor.silent || !this.prefs.sound();
        if (generation !== this.generation || !this.lifecycle.isCurrent(epoch))
          break;
        await this.nativeAdapter!.showDescriptor(descriptor);
        if (generation !== this.generation || !this.lifecycle.isCurrent(epoch))
          await this.adapter.clear();
      }
      if (this.lifecycle.isCurrent(epoch)) this.desktopSince = end;
    };
    await run();
  }
}
