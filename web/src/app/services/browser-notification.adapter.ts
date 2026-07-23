import { NotificationAdapter } from './notification-adapter';
import { NotificationPrefsService } from './notification-prefs.service';
import type { NotificationDescriptor, NotifAction } from './notification-descriptor.model';

/** The SW registration scope the foreground path renders through. The push service worker
 *  (web/public/push/sw-push.js) is registered at `/push/` by WebPushService.subscribeAndRegister whenever
 *  notification permission is granted; it owns the `notificationclick` handler, so routing the in-tab render
 *  through THIS registration (not in-page `new Notification`) is what makes per-card dismiss + body-tap
 *  deep-link work — the SW's `notificationclick` fires for SW-shown notifications only. */
const SW_SCOPE = '/push/';

/** The `tag` prefix shared by every SOMS shade notification (`soms-away` summary, `soms-thread-<id>` per-
 *  thread) — used by {@link BrowserNotificationAdapter.clear} to close only ours among a registration's
 *  active notifications. Mirrors the backend `AWAY_SUMMARY_TAG` / per-thread tag template. */
const SOMS_TAG_PREFIX = 'soms-';

/** A Web Notifications API action button — `{action, title}` (the descriptor's `NotifAction` uses `id` for
 *  the same slot). Declared here because this TS lib's `NotificationOptions` omits `actions` +
 *  `NotificationAction`, even though `ServiceWorkerRegistration.showNotification` accepts them at runtime. */
interface WebNotificationAction {
  action: string;
  title: string;
}

/**
 * Map a server-authored {@link NotifAction} (`{id,title,...}`) onto the Web Notifications API button shape
 * (`{action,title}`). The two contracts disagree on the id key (`id` vs `action`) — passing the descriptor
 * straight through (as the legacy code did) yields no working buttons, because the API keys off `action`.
 * `style` has no API equivalent and is dropped; `type:'text'` (inline reply) is a future action not shipped
 * today, so it is folded out for now. Pure + exported for unit test.
 */
export function mapActions(actions: NotifAction[] | undefined): WebNotificationAction[] {
  return (actions ?? []).map((a) => ({ action: a.id, title: a.title }));
}

/**
 * Browser / PWA in-tab attention notification. Renders through the push service worker's registration
 * (`registration.showNotification`) so that the SW's `notificationclick` handler fires — that is the ONLY
 * context in which notification ACTION BUTTONS fire (the `notificationclick` + `event.action` callback is a
 * ServiceWorkerGlobalScope-only event). In-page `new Notification` action buttons are display-only, so the
 * foreground per-card dismiss + body-tap deep-link require a SW-owned notification. Falls back to in-page
 * `new Notification` (no actions) only in the brief window before sw-push registers.
 *
 * The server-authored {@link NotificationDescriptor} maps field-for-field onto `showNotification(title, opts)`:
 *  - `tag` (+ `renotify`) → the replace-by-tag primitive (one shade entry, re-banner on replace);
 *  - `icon` → the composited stacked-avatar PNG (null → omit, the browser shows its default);
 *  - `silent` → the quiet flag (falls back to the Sound pref when the descriptor leaves it unset);
 *  - `actions` → the native action buttons (mapped via {@link mapActions});
 *  - `kind:'clear'` → `.close()` the tagged notification (server-driven cancel).
 *
 * The app-level master (`enabled`) is the in-app mute (the browser permission itself is terminal).
 */
export class BrowserNotificationAdapter extends NotificationAdapter {
  /** The push-SW registration, lazily resolved on first render and cached (stable per session). `undefined` =
   *  not yet looked up; `null` = looked up + absent (fall back to in-page `new Notification`). */
  private swReg: ServiceWorkerRegistration | null | undefined;

  /** Live in-page Notifications from the FALLBACK path only (keyed by `tag`), so `clear()` / `kind:'clear'`
   *  can close them when no SW registration is available yet. SW-rendered notifications are closed via
   *  `getNotifications()` instead and never enter this map. */
  private readonly active = new Map<string, Notification>();

  /** In-flight `render()` promises. `clear()` drains this BEFORE `getNotifications()` so a showNotification
   *  that hasn't resolved yet is visible (and closeable) — otherwise it survives the clear as a stray card. */
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly prefs: NotificationPrefsService) {
    super();
  }

  async showDescriptor(d: NotificationDescriptor): Promise<void> {
    if (d.kind === 'clear') {
      await this.closeByTag(d.tag);
      return;
    }
    if (!this.prefs.enabled()) return; // app-level master (the permission is terminal; this is the mute)
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
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
      if (reg && 'showNotification' in reg) {
        // SW-owned notification — `notificationclick` fires in the SW, so action buttons work (per-card
        // dismiss + body-tap deep-link). The SW owns the click handler; the page never sees action taps
        // directly (sw-push postMessages them over). Built as a variable (not an inline literal) so the
        // extra `actions` field passes assignability without tripping the lib's NotificationOptions excess-
        // property check (which omits `actions`).
        const swOptions = { ...options, actions: mapActions(d.actions) };
        await reg.showNotification(d.title, swOptions);
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
    // Drain any in-flight render so a showNotification that just posted (but hasn't resolved) is visible to
    // getNotifications() below — otherwise it survives the clear as a stray card. allSettled: a rejected
    // render (swallowed inside render) must not block the close.
    if (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    // SW-owned notifications: close every SOMS shade card this registration is showing (getNotifications
    // returns only this registration's notifications, so the soms- filter is defensive against any future
    // tag collision).
    const reg = await this.swRegistration();
    if (reg) {
      try {
        for (const n of await reg.getNotifications()) {
          if ((n.tag ?? '').startsWith(SOMS_TAG_PREFIX)) n.close();
        }
      } catch {
        /* best-effort */
      }
    }
    // Fallback in-page notifications.
    for (const n of this.active.values()) {
      try {
        n.close();
      } catch {
        /* best-effort */
      }
    }
    this.active.clear();
  }

  /** Resolve + cache the push-SW registration (null when absent / SW unsupported). Cached for the session;
   *  a one-time lookup on first render. */
  private async swRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (this.swReg !== undefined) return this.swReg;
    try {
      this.swReg =
        'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration(SW_SCOPE) : null;
    } catch {
      this.swReg = null;
    }
    return this.swReg ?? null;
  }

  /** Close notifications carrying `tag` (a `kind:'clear'` server-driven cancel). Mirrors sw-push's clear path. */
  private async closeByTag(tag: string): Promise<void> {
    const reg = await this.swRegistration();
    if (reg) {
      try {
        for (const n of await reg.getNotifications({ tag })) n.close();
      } catch {
        /* best-effort */
      }
    }
    const inPage = this.active.get(tag);
    if (inPage) {
      try {
        inPage.close();
      } catch {
        /* best-effort */
      }
      this.active.delete(tag);
    }
  }
}
