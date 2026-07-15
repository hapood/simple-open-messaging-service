import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { Subscription, filter } from 'rxjs';
import { UserService } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { ThreadRepository } from '../../services/thread-store.service';
import { GroupEventService } from '../../services/group-event.service';
import { HomeShellComponent } from '../../components/home-shell/home-shell.component';
import { IndicatorSlotComponent } from '../../components/indicator-slot/indicator-slot.component';
import { ConnectionBannerComponent } from '../../components/connection-banner/connection-banner.component';
import { UpdateBannerComponent } from '../../components/update-banner/update-banner.component';
import { RootPopupComponent } from '../../components/root-popup/root-popup.component';

/**
 * Home route entry (`/`). Renders the unified responsive {@link HomeShellComponent} (which hosts the
 * chat + aside router-outlets), the top-right {@link IndicatorSlotComponent} (the single positioned anchor
 * for every status indicator — connection chip + update banner — placed here, the outermost authed layer,
 * so it floats over the shell's routed overlays on every mode), plus the root popup layer for the
 * transient editor dialogs. App bootstrap (profile / token / websocket) lives here because this route
 * component is always instantiated once the user is authed.
 */
@Component({
  selector: 'app-home',
  imports: [HomeShellComponent, IndicatorSlotComponent, ConnectionBannerComponent, UpdateBannerComponent, RootPopupComponent],
  template: `
    <app-home-shell />
    <app-indicator-slot>
      <app-connection-banner />
      <app-update-banner />
    </app-indicator-slot>
    <app-root-popup />
  `,
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly userService = inject(UserService);
  private readonly authService = inject(AuthService);
  private readonly wsService = inject(WebsocketService);
  // Injected to instantiate the DB-layer root singletons that self-subscribe to the SSE stream in their
  // constructors: ThreadRepository routes the thread-list data events (NEW_MESSAGE / THREAD_META /
  // THREAD_REVISION_UPDATED / PEER_PROFILE_UPDATED + reconnect refresh); GroupEventService routes the
  // GROUP_* control events (toasts / roster reload). Injecting them here guarantees their subscriptions
  // are alive for the whole home-route session regardless of which child panes are mounted.
  private readonly threadRepo = inject(ThreadRepository);
  private readonly groupEvents = inject(GroupEventService);

  private readonly subs: Subscription[] = [];

  ngOnInit() {
    this.userService.updateSessionProfile();
    // The singleton constructor does not re-run on re-login after logout, so reconnect WS here. (No
    // startup token renew — the session token is long-lived; the interceptor attaches it directly.)
    this.wsService.connect();

    // Friend-lifecycle notifications ride the generic NOTIFY event, discriminated by `data.type`:
    //  - FRIEND_REQUEST: an incoming request armed the unread badge → refetch the profile.
    //  - FRIEND_APPROVED / FRIEND_DELETED: thread-list add/delete is driven by the
    //    THREAD_REVISION_UPDATED delta handler (ThreadRepository — fetches the new thread with a
    //    precise FLIP, or removes locally), so the NOTIFY is a no-op for these.
    this.subs.push(
      this.wsService.eventSubject
        .pipe(filter((m) => m.event === 'NOTIFY'))
        .subscribe((m) => {
          const t = m.data?.type;
          if (t === 'FRIEND_APPROVED' || t === 'FRIEND_DELETED') return;
          this.userService.updateSessionProfile();
        }),
    );
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
  }
}
