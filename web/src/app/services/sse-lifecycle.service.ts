import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BROWSER_SESSION } from './browser-session.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { AuthService } from './auth.service';
import { PushRegistrationService } from './push-registration.service';
import { WebsocketService } from './websocket.service';
import { ThreadRepository } from './thread-store.service';
import { apiOrigin, isTauri } from './runtime';

/** Application-session realtime orchestration. Transport reports events; auth owns session actions.
 * Browser foreground recovery lives here; native connection owners keep their foreground lifecycle. */
@Injectable({ providedIn: 'root' })
export class SseLifecycleService {
  private readonly browserSession = inject(BROWSER_SESSION);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly auth = inject(AuthService);
  private readonly ws = inject(WebsocketService);
  // Android may replay cached HELLO synchronously from connect(), before the home route mounts.
  // Repository consumers must exist before any authentication/origin effect can start receiving.
  private readonly threads = inject(ThreadRepository);
  private readonly pushRegistration = inject(PushRegistrationService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // Install reactions before restoration or any effect can start receiving, including cached HELLO.
    this.ws.forcedLogout$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((reason) => this.auth.redoLoginAuth(reason));
    this.ws.eventSubject
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        if (message.event !== 'HELLO' || !this.browserSession) {
          this.pushRegistration.onEvent(message.event, message.data);
          return;
        }
        const data = message.data as { userId?: number; sessionId?: number } | undefined;
        if (!Number.isSafeInteger(data?.userId) || (data?.userId ?? 0) <= 0 ||
            !Number.isSafeInteger(data?.sessionId) || (data?.sessionId ?? 0) <= 0) return;
        const scope = this.lifecycle.capture();
        if (!scope.sessionId || this.browserSession.currentSession?.id !== scope.sessionId) return;
        void this.browserSession.bindIdentity({ userId: data!.userId!, serverSessionId: data!.sessionId! })
          .then(() => {
            if (this.lifecycle.isCurrent(scope))
              this.pushRegistration.onEvent(message.event, message.data);
          })
          .catch((error) => {
            if (this.lifecycle.isCurrent(scope))
              console.warn('[session] server identity binding failed', error);
          });
      });

    let previousOrigin: string | undefined;
    effect(() => {
      const authenticated = this.auth.loggedIn();
      const origin = apiOrigin();
      untracked(() => {
        if (!authenticated || !this.auth.isLoggedIn()) this.ws.disconnect();
        else {
          if (previousOrigin !== undefined && previousOrigin !== origin)
            this.ws.disconnect();
          this.ws.connect();
        }
        previousOrigin = origin;
      });
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      this.destroyRef.onDestroy(() =>
        document.removeEventListener(
          'visibilitychange',
          this.onVisibilityChange,
        ),
      );
    }
  }

  /** Bootstrap awaits restoration only after the transport's session reactions are installed. */
  restoreSession(): Promise<void> {
    return this.auth.restoreSession();
  }

  private onVisibilityChange = (): void => {
    if (!isTauri() && document.visibilityState === 'visible') this.ws.connect();
  };
}
