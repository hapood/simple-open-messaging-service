import { parseNotificationOpening } from '../../../../shared/notification-opening';
import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ConversationListService } from './conversation-list.service';
import {
  apiOrigin,
  isAndroidNative,
  isTauri,
  listenEvent,
  tauriInvoke,
} from './runtime';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG, parseSwNotifMessage } from './sw-notif-protocol';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService } from './webdb.service';
import { WebPushService } from './web-push.service';
import { ThreadNavigationIntentService } from './thread-navigation-intent.service';
import { uuid } from '../lib/uuid';
import { notificationTarget } from './notification-routing';
import { UserService } from './user.service';
import { DesktopBadgeService } from './desktop-badge.service';

/** Browser: bridge worker-projected updates to the push service worker, and answer active-chat
 * queries. Android sends only the selected chat to native; Rust projects its notifications. */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly nav = inject(NavStateMachineService);
  private readonly navigation = inject(ThreadNavigationIntentService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly webdb = inject(WebdbService);
  private readonly user = inject(UserService);
  private readonly webPush = inject(WebPushService);
  private readonly baseTitle =
    typeof document !== 'undefined' ? document.title : 'SOMS';
  private readonly focused = signal(true);
  private readonly unreadTotal = computed(() =>
    this.convList.items().reduce((sum, item) => sum + item.unreadCount, 0),
  );
  private navigationQueue: Promise<void> = Promise.resolve();
  private readonly browserAdapter?: BrowserNotificationAdapter;
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
    if (isTauri()) {
      this.nativeAdapter = new TauriNotificationAdapter();
      inject(DesktopBadgeService);
    }
    if (!this.nativeAdapter)
      this.browserAdapter = new BrowserNotificationAdapter();
    if (isTauri()) this.installDesktopNavigation();
    const blur = () => this.onFocusChange(false);
    const focus = () =>
      this.onFocusChange(document.visibilityState === 'visible');
    const visibility = () =>
      this.onFocusChange(
        document.visibilityState === 'visible' && document.hasFocus(),
      );
    visibility();
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
      // Closing the app is not logout; retain system notifications and activation receipts.
      this.nativeAdapter?.dispose();
    });
    effect(() => {
      const threadId =
        this.nav.topSection() === 'chats' ? this.nav.chatThreadId() : undefined;
      const focused = this.focused();
      if (this.nativeAdapter) {
        void this.nativeAdapter.presentationChanged();
      } else if (focused && threadId !== undefined) {
        void this.browserAdapter?.presentationChanged();
      }
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
        .subscribe((batch) => {
          const scope = this.lifecycle.capture();
          void this.webPush
            .worker()
            .then((registration) => {
              if (this.lifecycle.isCurrent(scope))
                registration?.active?.postMessage({
                  type: SOMS_NOTIF_MSG.PRESENT,
                  ...batch,
                });
            })
            .catch((error) =>
              console.warn('[notification] worker unavailable', error),
            );
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
      const scope = this.lifecycle.capture();
      this.navigationQueue = this.navigationQueue
        .then(async () => {
          if (destroyed || !this.lifecycle.isCurrent(scope)) return;
          const tap = await tauriInvoke<{
            id: string;
            target?: unknown;
            latestSeq?: unknown;
          } | null>('desktop_notification_pending');
          const opening = parseNotificationOpening(tap);
          if (
            !tap ||
            destroyed ||
            !this.lifecycle.isCurrent(scope) ||
            typeof tap.id !== 'string' ||
            !tap.id.trim() ||
            !opening
          )
            return;
          this.navigation.offer(
            {
              source: 'desktop',
              id: tap.id,
              ...opening,
              acknowledge: () =>
                tauriInvoke<void>('desktop_notification_acknowledge', {
                  id: tap.id,
                  ...opening,
                }),
            },
            scope,
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
  }

  private dismissActive(): void {
    if (this.nativeAdapter) void this.nativeAdapter.clear();
    else void this.browserAdapter?.clear();
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
      if (data.stateCommitted) void this.user.refreshCommittedStateFeed();
    } else if (data.type === SOMS_NOTIF_MSG.OPEN) {
      const opening = parseNotificationOpening(data);
      if (!opening) return;
      window.focus();
      this.navigation.offer({
        source: 'web',
        id: uuid(),
        ...opening,
        sessionId: data.sessionId,
      });
    }
  }
}
