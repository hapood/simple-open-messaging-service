import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { apiPrefix } from './constants';
import { apiOrigin } from './runtime';
import { PreferenceStore } from './preference-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SUPPRESS_HTTP_ERROR_TOAST } from '../request-context';

export interface PushRegistration {
  platform: 'WEB' | 'ANDROID';
  token: string;
  deviceId?: string;
  p256dh?: string;
  auth?: string;
}

export interface PushRegistrationAdapter {
  read(): Promise<PushRegistration | null>;
  create(replace: boolean): Promise<PushRegistration | null>;
}

interface PreparedSubscription {
  sessionId: number;
  rev: number;
  phase: 'replacing' | 'prepared';
  token: string | null;
}

/** Shared Web/Android recovery. Only HELLO, revision events, permission changes
 * and platform token changes trigger work; there is no periodic synchronization. */
@Injectable({ providedIn: 'root' })
export class PushRegistrationService {
  private readonly http = inject(HttpClient);
  private readonly preferences = inject(PreferenceStore);
  private readonly lifecycle = inject(SessionLifecycleService);
  private adapter?: PushRegistrationAdapter;
  private sessionId = 0;
  private requestedRev = 0;
  private completedRev = 0;
  private running = false;
  private dirty = false;
  private retry?: ReturnType<typeof setTimeout>;
  private failures = 0;

  constructor() {
    this.lifecycle.invalidated$.subscribe(() => {
      this.sessionId = this.requestedRev = this.completedRev = 0;
      this.dirty = false;
      this.failures = 0;
      clearTimeout(this.retry);
      const key = `push-registration:${apiOrigin()}${apiPrefix()}`;
      const clear = () => this.preferences.remove('device', key);
      if (typeof navigator !== 'undefined' && navigator.locks)
        void navigator.locks.request('soms-push-registration', clear);
      else void clear();
    });
  }

  setAdapter(adapter: PushRegistrationAdapter): void {
    this.adapter = adapter;
    this.refresh();
  }

  onEvent(event: string, data: unknown): void {
    if (event !== 'HELLO' && event !== 'PUSH_SUBSCRIPTION_CHANGED') return;
    const state = data as {
      sessionId?: number;
      pushSubscriptionRev?: number;
    } | null;
    const sessionId = state?.sessionId;
    const rev = state?.pushSubscriptionRev;
    if (
      !Number.isInteger(sessionId) ||
      !Number.isInteger(rev) ||
      !sessionId ||
      sessionId < 1 ||
      !rev ||
      rev < 1 ||
      rev > 2147483647
    )
      return;
    if (event !== 'HELLO' && sessionId !== this.sessionId) return;
    const previousSession = this.sessionId;
    const previousRev = this.requestedRev;
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.requestedRev = this.completedRev = 0;
    }
    this.requestedRev = Math.max(this.requestedRev, rev);
    if (
      this.requestedRev > this.completedRev &&
      (!this.running ||
        previousSession !== sessionId ||
        previousRev !== this.requestedRev)
    )
      this.wake();
  }

  /** Also used by platform rotation callbacks and explicit user actions. */
  refresh(): void {
    this.completedRev = 0;
    this.wake();
  }

  private wake(): void {
    if (!this.adapter || !this.sessionId || !this.requestedRev) return;
    this.dirty = true;
    clearTimeout(this.retry);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        const scope = this.lifecycle.capture();
        const sessionId = this.sessionId;
        const rev = this.requestedRev;
        const prefix = apiPrefix();
        const origin = apiOrigin();
        const current = () =>
          this.lifecycle.isCurrent(scope) &&
          this.sessionId === sessionId &&
          this.requestedRev === rev &&
          apiOrigin() === origin;
        const reconcile = async () => {
          if (!current() || !this.adapter) return;
          const key = `push-registration:${origin}${prefix}`;
          const saved = await this.preferences.get<PreparedSubscription>(
            'device',
            key,
          );
          let local = await this.adapter.read();
          if (!current()) return;
          const sameGeneration =
            saved?.sessionId === sessionId && saved.rev === rev;
          const alreadyPrepared =
            sameGeneration &&
            (saved.phase === 'prepared' ||
              saved.token !== (local?.token ?? null));
          const replace = rev > 1 && !alreadyPrepared;
          if (replace || !local) {
            await this.preferences.set<PreparedSubscription>('device', key, {
              sessionId,
              rev,
              phase: 'replacing',
              token: local?.token ?? null,
            });
            if (!current()) return;
            local = await this.adapter.create(replace);
            if (!local && current())
              await this.preferences.remove('device', key);
          }
          // Denied permission or unavailable platform waits for a new external event.
          if (!local || !current()) return;
          await this.preferences.set<PreparedSubscription>('device', key, {
            sessionId,
            rev,
            phase: 'prepared',
            token: local.token,
          });
          if (!current()) return;
          const response = await firstValueFrom(
            this.http
              .post<{
                code: number;
                data: {
                  sessionId: number;
                  pushSubscriptionRev: number;
                  registered: boolean;
                };
              }>(
                `${prefix}/devices/register`,
                {
                  ...local,
                  sessionId,
                  pushSubscriptionRev: rev,
                },
                {
                  context: new HttpContext().set(
                    SUPPRESS_HTTP_ERROR_TOAST,
                    true,
                  ),
                },
              )
              .pipe(timeout(20000)),
          );
          if (!current()) return;
          if (response.code !== 0 || response.data?.sessionId !== sessionId)
            throw new Error('Push registration failed');
          if (!response.data.registered) {
            if (response.data.pushSubscriptionRev <= rev)
              throw new Error('Invalid push registration revision');
            this.onEvent('PUSH_SUBSCRIPTION_CHANGED', response.data);
            return;
          }
          this.completedRev = rev;
          this.failures = 0;
        };
        try {
          if (navigator.locks)
            await navigator.locks.request('soms-push-registration', reconcile);
          else await reconcile();
        } catch {
          if (current() && ++this.failures <= 5) {
            // Bounded retry of this failed operation, not a heartbeat or polling loop.
            this.retry = setTimeout(
              () => this.wake(),
              Math.min(30000, 1000 * 2 ** this.failures),
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
