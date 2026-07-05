import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslocoService } from '@jsverse/transloco';
import { apiPrefix } from './constants';
import { isTauri } from './runtime';
import { ToastService } from './toast.service';

/**
 * Standard Web Push (Push API + VAPID) for the browser/PWA build. Covers every browser that implements
 * the Web Push standard — desktop Chrome/Firefox/Safari/Edge, AND iOS Safari 16.4+ installed as a
 * Home-Screen PWA. Self-guards to a no-op under the Tauri shell (Android push is FCM + WorkManager in
 * PushService; desktop attention is UnreadAttentionService) and on browsers without PushManager/SW.
 *
 * Failure is graceful at every step (the user's directive: never crash, just warn): unsupported browser,
 * blocked permission, subscription error, or registration HTTP failure each surface a translated toast
 * and degrade silently to foreground-only delivery. The dedicated push SW lives at scope '/push/' so it
 * doesn't collide with ngsw-worker.js at '/' (push events fire on a registration regardless of scope).
 */
@Injectable({ providedIn: 'root' })
export class WebPushService {
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);

  /** The endpoint currently registered with the backend (null = not subscribed). */
  private registeredEndpoint: string | null = null;

  /** Wire up at app boot (AppComponent), after a session is restored. No-op when unsupported. */
  async init(): Promise<void> {
    if (isTauri()) return; // Android/desktop shells use other channels.
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('showNotification' in window)) {
      return; // unsupported — silent (no toast; the user didn't ask for anything yet)
    }
    try {
      await this.subscribeAndRegister();
    } catch (e) {
      // subscribeAndRegister already toasted a specific cause; this is the catch-all.
    }
  }

  /** Called by AuthService after login — re-attempt subscription in case the first init ran pre-login. */
  async onLogin(): Promise<void> {
    if (isTauri()) return;
    if (this.registeredEndpoint) return; // already subscribed
    try {
      await this.subscribeAndRegister();
    } catch (e) {
      /* toasted inside */
    }
  }

  /** Called by AuthService.logout BEFORE it clears the access token. Unsubscribes + unregisters. */
  async unregister(): Promise<void> {
    if (isTauri()) return;
    const endpoint = this.registeredEndpoint;
    if (!endpoint) return;
    this.registeredEndpoint = null;
    // Unregister from the backend (best-effort; the access token is still live at this point).
    this.http
      .delete(`${apiPrefix}/devices/register/${encodeURIComponent(endpoint)}`)
      .subscribe({ error: () => { /* a stale endpoint is pruned on next send */ } });
    // Unsubscribe the browser-side subscription so the push service stops holding a channel.
    try {
      const reg = await navigator.serviceWorker.getRegistration('/push/');
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe();
    } catch (e) {
      /* best-effort */
    }
  }

  /** The full subscribe flow: ensure permission → register the SW → fetch VAPID key → subscribe →
   *  POST to /devices/register. Each failure surfaces a specific translated toast + returns. */
  private async subscribeAndRegister(): Promise<void> {
    // 1. Permission.
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        this.toast.warn(this.t('push.permissionDenied'));
        return;
      }
    } else if (Notification.permission === 'denied') {
      this.toast.warn(this.t('push.permissionDenied'));
      return;
    }
    // 2. Register the push SW (scope '/push/' — ngsw owns '/').
    let reg: ServiceWorkerRegistration;
    try {
      reg = await navigator.serviceWorker.register('./push/sw-push.js', { scope: './push/' });
    } catch (e) {
      this.toast.warn(this.t('push.subscribeFailed'));
      return;
    }
    // 3. VAPID public key (single source of truth = backend env).
    const publicKey = await this.fetchVapidKey();
    if (!publicKey) {
      this.toast.warn(this.t('push.subscribeFailed'));
      return;
    }
    // 4. Subscribe (re-use an existing subscription if one exists — idempotent).
    let sub: PushSubscription;
    try {
      sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
    } catch (e) {
      this.toast.warn(this.t('push.subscribeFailed'));
      return;
    }
    // 5. Register with the backend (idempotent upsert on endpoint).
    if (sub.endpoint === this.registeredEndpoint) return;
    this.http
      .post<{ code: number }>(`${apiPrefix}/devices/register`, {
        token: sub.endpoint,
        platform: 'WEB',
        p256dh: sub.getKey('p256dh') ? base64UrlEncode(sub.getKey('p256dh')!) : undefined,
        auth: sub.getKey('auth') ? base64UrlEncode(sub.getKey('auth')!) : undefined,
      })
      .subscribe({
        next: (r) => { if (r.code === 0) this.registeredEndpoint = sub.endpoint; },
        error: () => this.toast.warn(this.t('push.subscribeFailed')),
      });
  }

  private async fetchVapidKey(): Promise<string | null> {
    try {
      const res = await fetch(`${apiPrefix}/notifications/vapid-key`);
      const json = await res.json();
      const pk = json?.data?.publicKey;
      return typeof pk === 'string' && pk.length > 0 ? pk : null;
    } catch (e) {
      return null;
    }
  }

  private t(key: string): string {
    return this.transloco.translate(key) ?? key;
  }
}

/** VAPID keys + PushSubscription keys are base64url-encoded; the Web Push APIs need this exact encoding.
 *  Built on an explicit ArrayBuffer so the result satisfies the DOM's `BufferSource` (the TS lib's
 *  generic `Uint8Array<ArrayBufferLike>` would otherwise trip `ArrayBufferView<ArrayBuffer>`). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
