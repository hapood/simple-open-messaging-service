import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { Subscription, filter } from 'rxjs';
import { UserService } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { ConversationListService } from '../../services/conversation-list.service';
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
  private readonly convList = inject(ConversationListService);
  // Injected to instantiate the root singleton that routes the GROUP_* SSE events to the
  // conversation list / open roster / affected user (the service self-subscribes in its constructor).
  private readonly groupEvents = inject(GroupEventService);

  private readonly subs: Subscription[] = [];

  ngOnInit() {
    this.userService.updateSessionProfile();
    // 必须 subscribe：HttpClient.post 是冷 Observable，不订阅不会发请求。
    // 启动即 renew-access 取新 access token（旧 token 可能将过期）；拦截器无 token 时也会主动 renew，
    // 但这里先订阅可让首个受保护请求免去多等一次往返，避免启动初期的请求排队。
    this.authService.renewAccessToken().subscribe();
    // 单例 constructor 不会在登出后重登时再跑，需在此重连 WS
    this.wsService.connect();

    // Friend-lifecycle notifications ride the generic NOTIFY event, discriminated by `data.type`:
    //  - FRIEND_REQUEST: an incoming request armed the unread badge → refetch the profile.
    //  - FRIEND_APPROVED / FRIEND_DELETED: thread-list add/delete is driven by the
    //    THREAD_REVISION_UPDATED delta handler (ConversationListService — fetches the new thread with
    //    a precise FLIP, or removes locally), so the NOTIFY is a no-op for these.
    this.subs.push(
      this.wsService.eventSubject
        .pipe(filter((m) => m.event === 'NOTIFY'))
        .subscribe((m) => {
          const t = m.data?.type;
          if (t === 'FRIEND_APPROVED' || t === 'FRIEND_DELETED') return;
          this.userService.updateSessionProfile();
        }),
    );
    // Live conversation list: an incoming message refreshes that thread's preview + bumps unread
    // (unless it's the thread the user is currently viewing). On reconnect, the server (source of
    // truth) is re-read — the SSE stream does not replay frames missed during the disconnect.
    this.subs.push(
      this.wsService.eventSubject
        .pipe(filter((m) => m.event === 'NEW_MESSAGE' && m.data !== undefined))
        .subscribe((m) => this.convList.onNewMessage(m.data)),
    );
    this.subs.push(
      this.wsService.reconnect$.subscribe(() => {
        // Force-reload: re-seed the thread-revision cursor from the server's current threadRevision
        // (any add/delete missed during the disconnect) and re-snapshot at that fresh revision,
        // cancelling any in-flight load so the snapshot pins the new cursor consistently.
        this.convList.load({ force: true });
      }),
    );
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
  }
}
