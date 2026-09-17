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
import { ConversationListService } from './conversation-list.service';
import { isAndroidNative, isTauri, listenEvent, tauriInvoke } from './runtime';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationAdapter } from './notification-adapter';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG, parseSwNotifMessage } from './sw-notif-protocol';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  advanceNotificationSince,
  readNotificationSince,
} from './browser-notification-checkpoint';
import {
  threadNotificationDescriptor,
  threadNotificationIcon,
  type ThreadNotificationUpdate,
} from './thread-notification';
import { WebdbService } from './webdb.service';

/** Desktop/browser presentation consumes committed, reconciled thread-feed updates.
 * It neither queries a notification endpoint nor owns a second feed drain.
 * Android presentation belongs to the native runtime. */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly prefs = inject(NotificationPrefsService);
  private readonly nav = inject(NavStateMachineService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly i18n = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly webdb = inject(WebdbService);
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
  private readonly adapter!: NotificationAdapter;

  constructor() {
    if (typeof document === 'undefined' || isAndroidNative()) return;
    this.adapter = isTauri()
      ? new TauriNotificationAdapter()
      : new BrowserNotificationAdapter(this.prefs);
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
      this.dismissActive();
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
    this.convList.threadNotifications$
      .pipe(takeUntilDestroyed())
      .subscribe((updates) => {
        const epoch = this.lifecycle.accountEpoch;
        const generation = this.generation;
        const suppressed = this.focused();
        this.queue = this.queue
          .then(() => this.present(updates, epoch, generation, suppressed))
          .catch(() => {});
      });
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
            threadId: number;
          } | null>('desktop_notification_pending');
          if (!tap || destroyed || !this.lifecycle.isCurrent(epoch)) return;
          this.nav.openChat(tap.threadId);
          await tauriInvoke<void>('desktop_notification_acknowledge', tap);
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
      // Invalidate queued renders; they still consume their presentation checkpoint silently.
      this.generation++;
      void this.adapter.clear();
    }
  }

  private dismissActive(): void {
    this.generation++;
    this.desktopSince = 0;
    void this.adapter.clear();
  }

  private onSwMessage(event: MessageEvent): void {
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
      this.nav.openChat(data.threadId);
    }
  }

  private async present(
    batch: ThreadNotificationUpdate[],
    epoch: number,
    generation: number,
    suppressed: boolean,
  ): Promise<void> {
    const run = async () => {
      if (!this.lifecycle.isCurrent(epoch)) return;
      const after = isTauri()
        ? this.desktopSince
        : await readNotificationSince();
      if (!this.lifecycle.isCurrent(epoch)) return;
      const fresh = batch.filter(
        (update) => update.state.threadFeedId > after,
      );
      const end = Math.max(
        after,
        ...fresh.map((update) => update.state.threadFeedId),
      );
      for (const update of fresh) {
        if (!this.lifecycle.isCurrent(epoch)) return;
        if (
          generation !== this.generation ||
          this.focused() ||
          !this.prefs.enabled()
        )
          break;
        if (suppressed) continue;
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
        );
        descriptor.silent = !!descriptor.silent || !this.prefs.sound();
        if (!isTauri() && descriptor.count > 0)
          descriptor.icon = await threadNotificationIcon(
            this.webdb,
            update.item,
          );
        if (generation !== this.generation || !this.lifecycle.isCurrent(epoch))
          break;
        await this.adapter.showDescriptor(descriptor);
        if (generation !== this.generation || !this.lifecycle.isCurrent(epoch))
          await this.adapter.clear();
      }
      if (this.lifecycle.isCurrent(epoch)) {
        if (isTauri()) this.desktopSince = end;
        else await advanceNotificationSince(end);
      }
    };
    if (!isTauri() && navigator.locks) {
      await navigator.locks.request('soms-notification-projection', run);
    } else await run();
  }
}
