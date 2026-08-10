import { Component, inject, OnInit } from '@angular/core';
import { UserService } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { ThreadRepository } from '../../services/thread-store.service';
import { GroupEventService } from '../../services/group-event.service';
import { HomeShellComponent } from '../../components/home-shell/home-shell.component';
import { IndicatorSlotComponent } from '../../components/indicator-slot/indicator-slot.component';
import { ConnectionBannerComponent } from '../../components/connection-banner/connection-banner.component';
import { RootPopupComponent } from '../../components/root-popup/root-popup.component';

/**
 * Home route entry (`/`). Renders the unified responsive {@link HomeShellComponent} (which hosts the
 * chat + aside router-outlets), the top-center {@link IndicatorSlotComponent} (the positioned connection
 * status anchor, placed here at the outermost authenticated layer,
 * so it floats over the shell's routed overlays on every mode), plus the root popup layer for the
 * transient editor dialogs. App bootstrap (profile / token / websocket) lives here because this route
 * component is always instantiated once the user is authed.
 */
@Component({
  selector: 'app-home',
  imports: [
    HomeShellComponent,
    IndicatorSlotComponent,
    ConnectionBannerComponent,
    RootPopupComponent,
  ],
  template: `
    <app-home-shell />
    <app-indicator-slot>
      <app-connection-banner />
    </app-indicator-slot>
    <app-root-popup />
  `,
})
export class HomeComponent implements OnInit {
  private readonly userService = inject(UserService);
  private readonly authService = inject(AuthService);
  private readonly wsService = inject(WebsocketService);
  // Injected to instantiate the DB-layer root singletons that self-subscribe to the SSE stream in their
  // constructors: ThreadRepository routes the thread-list data events (NEW_MESSAGE / THREAD_META /
  // STATE_REV_UPDATED +
  // reconnect refresh); GroupEventService routes the GROUP_* control events (toasts / roster reload).
  // Injecting them here guarantees their subscriptions are alive for the whole home-route session
  // regardless of which child panes are mounted.
  private readonly threadRepo = inject(ThreadRepository);
  private readonly groupEvents = inject(GroupEventService);

  ngOnInit() {
    // The self profile is loaded by the HELLO connect handshake now (UserService.establishSession gates
    // it on the cached profileRev) — no cold-start profile fetch here.
    // The singleton constructor does not re-run on re-login after logout, so reconnect WS here. (No
    // startup token renew — the session token is long-lived; the interceptor attaches it directly.)
    this.wsService.connect();

    // Friend-lifecycle signals no longer need a dedicated SSE subscription here:
    //  - FRIEND_REQUEST badge: armed by the unified state delta and compared with this device's seen cursor.
    //  - FRIEND_APPROVED / FRIEND_DELETED: thread-list add/delete is driven by STATE_REV_UPDATED.
  }
}
