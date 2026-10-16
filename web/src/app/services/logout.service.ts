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
 * Lives outside {@link AuthService}: explicit logout coordinates authentication, navigation and a
 * defensive transport disconnect. Infrastructure does not depend on this application action service.
 */
@Injectable({ providedIn: 'root' })
export class LogoutService {
  private readonly auth = inject(AuthService);
  private readonly ws = inject(WebsocketService);
  private readonly routeService = inject(RouteService);

  logout(): void {
    // AuthService emits only after local cache deletion succeeds. Remote revocation is already launched at
    // that boundary and deliberately does not delay this UI transition.
    try {
      this.auth.logout().subscribe({
        next: () => {
          try {
            this.ws.disconnect();
          } catch {
            // The local session is already gone; a stale bridge must not block navigation.
          }
          this.routeService.redirect(RoutePage.AUTH_LOGIN);
        },
        error: () => {},
      });
    } catch {
      // A synchronous cache failure leaves the authenticated UI intact so logout can be retried.
    }
  }
}
