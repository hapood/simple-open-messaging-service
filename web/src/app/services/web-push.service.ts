import { Injectable, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { apiPrefix } from './constants';
import { isTauri } from './runtime';
import { ToastService } from './toast.service';
import { PreferenceStore } from './preference-store.service';
import { SessionStore } from './session/session-store';
import { SessionLifecycleService } from './session-lifecycle.service';
import { uuid } from '../lib/uuid';
import { getPushWorkerRegistration } from './push-worker-registration';
import {
  PushRegistrationService,
  type PushRegistration,
} from './push-registration.service';

/** Browser adapter. The shared session coordinator owns registration and recovery. */
@Injectable({ providedIn: 'root' })
export class WebPushService {
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);
  private readonly preferences = inject(PreferenceStore);
  private readonly registration = inject(PushRegistrationService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly sessionStore = new SessionStore(this.preferences);
  private deviceIdPromise: Promise<string> | null = null;
  private initialized = false;

  readonly permission = signal<NotificationPermission | 'unsupported'>(
    typeof Notification !== 'undefined' && window.isSecureContext
      ? Notification.permission
      : 'unsupported',
  );

  async init(): Promise<void> {
    if (isTauri() || this.initialized) return;
    this.initialized = true;
    this.refreshPermission();
    window.addEventListener('focus', () => this.refreshPermission(), {
      passive: true,
    });
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'soms-push-subscription-changed')
        this.registration.refresh();
    });
    this.registration.setAdapter({
      read: () => this.read(),
      create: (replace) => this.create(replace),
    });
  }

  async onLogin(): Promise<void> {
    await this.init();
    this.refreshPermission();
  }

  async enable(): Promise<NotificationPermission | 'unsupported'> {
    if (typeof Notification === 'undefined' || !window.isSecureContext)
      return 'unsupported';
    const perm =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    this.permission.set(perm);
    if (perm !== 'granted') {
      this.toast.warn(this.transloco.translate('push.permissionDenied'));
      return perm;
    }
    await this.init();
    this.registration.refresh();
    return perm;
  }

  private refreshPermission(): void {
    if (typeof Notification === 'undefined' || !window.isSecureContext) return;
    const before = this.permission();
    this.permission.set(Notification.permission);
    if (before !== 'granted' && this.permission() === 'granted')
      this.registration.refresh();
  }

  /** Ensure the notification renderer is active before forwarding a projected worker batch. */
  async worker(): Promise<ServiceWorkerRegistration | null> {
    if (isTauri()) return null;
    const scope = this.lifecycle.capture();
    if (!scope.sessionId || !this.lifecycle.isCurrent(scope)) return null;
    const saved = await this.sessionStore.read();
    if (!this.lifecycle.isCurrent(scope) || saved?.phase !== 'active' ||
        saved.session?.id !== scope.sessionId || !saved.identity) return null;
    if (
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    )
      return null;
    const reg = await navigator.serviceWorker.register('/push/sw-push.js', {
      scope: '/push/',
      updateViaCache: 'none',
    });
    if (!reg.active) {
      const worker = reg.installing ?? reg.waiting;
      if (!worker) throw new Error('Push worker unavailable');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Push worker activation timed out'));
        }, 20000);
        const cleanup = () => {
          clearTimeout(timer);
          worker.removeEventListener('statechange', changed);
        };
        const changed = () => {
          if (worker.state === 'activated') {
            cleanup();
            resolve();
          } else if (worker.state === 'redundant') {
            cleanup();
            reject(new Error('Push worker redundant'));
          }
        };
        worker.addEventListener('statechange', changed);
        changed();
      });
    }
    return this.lifecycle.isCurrent(scope) ? reg : null;
  }

  /** Release an existing subscription only. Logout must never register a new worker. */
  async unsubscribe(): Promise<void> {
    if (isTauri() || !('serviceWorker' in navigator)) return;
    const release = async () => {
      const reg = await getPushWorkerRegistration();
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription && !(await subscription.unsubscribe())) {
        throw new Error('Could not cancel push subscription');
      }
    };
    // Serialize with registration recovery so an older subscribe cannot finish after logout.
    if (navigator.locks) await navigator.locks.request('soms-push-registration', release);
    else await release();
  }

  private async read(): Promise<PushRegistration | null> {
    const reg = await this.worker();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? this.serialize(sub) : null;
  }

  private async create(replace: boolean): Promise<PushRegistration | null> {
    const scope = this.lifecycle.capture();
    const reg = await this.worker();
    if (!reg || !this.lifecycle.isCurrent(scope)) return null;
    const response = await fetch(`${apiPrefix()}/notifications/vapid-key`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('VAPID key unavailable');
    if (!this.lifecycle.isCurrent(scope)) return null;
    const publicKey = (await response.json())?.data?.publicKey;
    if (typeof publicKey !== 'string' || !publicKey) return null;
    let sub = await reg.pushManager.getSubscription();
    if (sub && replace) {
      if (!this.lifecycle.isCurrent(scope)) return null;
      if (!(await sub.unsubscribe()))
        throw new Error('Could not remove expired subscription');
      sub = null;
    }
    if (!this.lifecycle.isCurrent(scope)) return null;
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    if (!this.lifecycle.isCurrent(scope)) {
      // A subscription created by a cancelled login must not survive as an orphan.
      if (!(await sub.unsubscribe())) throw new Error('Could not remove cancelled push subscription');
      return null;
    }
    return this.serialize(sub);
  }

  private async serialize(sub: PushSubscription): Promise<PushRegistration> {
    const p256dh = sub.getKey('p256dh');
    const auth = sub.getKey('auth');
    if (!p256dh || !auth) throw new Error('Missing push encryption keys');
    return {
      platform: 'WEB',
      token: sub.endpoint,
      deviceId: await this.clientDeviceId(),
      p256dh: base64UrlEncode(p256dh),
      auth: base64UrlEncode(auth),
    };
  }

  private clientDeviceId(): Promise<string> {
    return (this.deviceIdPromise ??= this.loadClientDeviceId());
  }

  private async loadClientDeviceId(): Promise<string> {
    const stored = await this.preferences.get<unknown>('device', 'device_id');
    if (typeof stored === 'string' && stored.length > 0 && stored.length <= 127)
      return stored;
    const created = uuid();
    await this.preferences.set('device', 'device_id', created);
    return created;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(
    (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
      .replace(/-/g, '+')
      .replace(/_/g, '/'),
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
