import { NotificationAdapter } from './notification-adapter';
import { NotificationPrefsService } from './notification-prefs.service';
import type { NotificationDescriptor } from './notification-descriptor.model';

/** The SW registration scope the foreground path renders through. The push service worker
 *  (web/public/push/sw-push.js) is registered at `/push/` by WebPushService whenever
 *  notification permission is granted; it owns the `notificationclick` handler, so routing the in-tab render
 *  through THIS registration (not in-page `new Notification`) is what makes per-card dismiss + body-tap
 *  deep-link work — the SW's `notificationclick` fires for SW-shown notifications only. */
const SW_SCOPE = '/push/';

/** Prefix shared by every SOMS per-thread shade notification. Used by
 * {@link BrowserNotificationAdapter.clear} to close only ours among a registration's active notifications. */
const SOMS_TAG_PREFIX = 'soms-';

const activeNotifications = new Map<string, Notification>();
const pendingNotifications = new Set<Promise<void>>();

/** Shared by presentation and explicit session boundaries, even before a presenter is constructed. */
export async function clearBrowserMessageNotifications(): Promise<void> {
  await Promise.allSettled([...pendingNotifications]);
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    for (const notification of (await reg?.getNotifications()) ?? []) {
      if (notification.tag.startsWith(SOMS_TAG_PREFIX)) notification.close();
    }
  }
  for (const notification of activeNotifications.values()) notification.close();
  activeNotifications.clear();
}

/** Browser presentation uses the push worker registration for notification-click routing. */
export class BrowserNotificationAdapter extends NotificationAdapter {
  /** The push-SW registration, lazily resolved on first render and cached (stable per session). `undefined` =
   *  not yet looked up; `null` = looked up + absent (fall back to in-page `new Notification`). */
  private swReg: ServiceWorkerRegistration | null | undefined;

  /** Live in-page Notifications from the FALLBACK path only (keyed by `tag`), so `clear()` can close them
   * when no SW registration is available yet. SW-rendered notifications are closed via `getNotifications()`
   * instead and never enter this map. */
  private readonly active = activeNotifications;

  /** In-flight `render()` promises. `clear()` drains this BEFORE `getNotifications()` so a showNotification
   *  that hasn't resolved yet is visible (and closeable) — otherwise it survives the clear as a stray card. */
  private readonly pending = pendingNotifications;

  constructor(private readonly prefs: NotificationPrefsService) {
    super();
  }

  async showDescriptor(d: NotificationDescriptor): Promise<void> {
    if (!this.prefs.enabled()) return; // app-level master (the permission is terminal; this is the mute)
    if (!('Notification' in window) || Notification.permission !== 'granted')
      return;
    // Track the in-flight render so `clear()` can await it before getNotifications().
    const p = this.render(d);
    this.pending.add(p);
    try {
      await p;
    } finally {
      this.pending.delete(p);
    }
  }

  /** The actual render (SW `showNotification`, else in-page `new Notification` fallback). Best-effort — a
   *  throw (permission revoked mid-flight, quota, …) is swallowed so one bad descriptor can't poison the
   *  batch or leave a rejected promise blocking a future `clear()`. */
  private async render(d: NotificationDescriptor): Promise<void> {
    try {
      // The TS DOM lib's NotificationOptions omits `renotify` (a Chromium-supported, spec-defined option not
      // yet typed). Extend it so the literal type-checks honestly instead of being cast away.
      const options: NotificationOptions & { renotify?: boolean } = {
        body: d.body,
        tag: d.tag,
        icon: d.icon ?? undefined,
        lang: d.lang,
        silent: d.silent ?? !this.prefs.sound(),
        data: d.data,
        renotify: d.renotify,
      };
      const reg = await this.swRegistration();
      if (d.count <= 0) {
        if (reg) {
          for (const notification of await reg.getNotifications({ tag: d.tag }))
            if (notification.tag === d.tag) notification.close();
        }
        this.active.get(d.tag)?.close();
        this.active.delete(d.tag);
        return;
      }
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(d.title, options);
        return;
      }
      // Fallback: no sw-push registration yet (brief pre-registration window, or SW unsupported). In-page
      // notifications can't fire actions, so omit them — body-tap still focuses the window.
      const n = new Notification(d.title, options);
      n.onclick = () => {
        window.focus();
        n.close();
      };
      n.addEventListener('close', () => {
        if (this.active.get(d.tag) === n) this.active.delete(d.tag);
      });
      this.active.set(d.tag, n);
    } catch {
      /* best-effort */
    }
  }

  async clear(): Promise<void> {
    await clearBrowserMessageNotifications().catch((error) => {
      console.warn('[notification] browser cleanup failed', error);
    });
  }

  /** Resolve + cache the push-SW registration (null when absent / SW unsupported). Cached for the session;
   *  a one-time lookup on first render. */
  private async swRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (this.swReg !== undefined) return this.swReg;
    try {
      this.swReg =
        'serviceWorker' in navigator
          ? await navigator.serviceWorker.getRegistration(SW_SCOPE)
          : null;
    } catch {
      this.swReg = null;
    }
    return this.swReg ?? null;
  }
}
