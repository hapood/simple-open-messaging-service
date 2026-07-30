import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import { WebsocketService } from './websocket.service';
import { RouteService, RoutePage } from './route.service';

/**
 * App-wide logout choreography: disconnect the realtime transport, revoke the session (server POST + local
 * state + native token — all handled by {@link AuthService.logout}), then redirect to login. Factored out so
 * every logout entry point runs the identical sequence; each host only decides whether to close its own pane
 * first (a dialog must, a section has nothing to close).
 *
 * Lives outside {@link AuthService} because that service must NOT inject {@link WebsocketService} — the
 * websocket owns a login effect that depends on auth state, so auth→ws would be a circular DI. This service
 * is the cycle-free meeting point (nothing injects it back except the logout call sites).
 */
@Injectable({ providedIn: 'root' })
export class LogoutService {
  private readonly auth = inject(AuthService);
  private readonly ws = inject(WebsocketService);
  private readonly routeService = inject(RouteService);

  logout(): void {
    // Disconnect explicitly and immediately (defence-in-depth — AuthService.logout flips loggedIn false,
    // whose effect also tears the socket down, but don't rely on that timing during the logout POST window).
    try {
      this.ws.disconnect();
    } catch {
      // Logout is a local escape hatch. A broken/stale realtime bridge must never strand the user in the
      // authenticated shell (or surface as an uncaught exception in a native WebView).
    }
    // AuthService drops every local session surface synchronously before returning the best-effort remote
    // revoke. Navigation must NOT wait for that old server: it may be offline, and a late callback must not
    // pull the user back from /config (or from a newly-established session) to the login page.
    try {
      this.auth.logout().subscribe({ error: () => {} });
    } catch {
      // `subscribe({ error })` only handles errors emitted after an Observable is returned. Native bridge
      // calls and local cleanup inside AuthService.logout can throw synchronously before that point.
    }
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }
}
