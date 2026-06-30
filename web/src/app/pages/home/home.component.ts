import { Component, inject, OnInit } from '@angular/core';
import { LayoutService } from '../../services/layout.service';
import { UserService } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { DesktopHomeComponent } from '../../components/desktop/desktop-home/desktop-home.component';
import { MobileHomeComponent } from '../../components/mobile/mobile-home/mobile-home.component';
import { TabletHomeComponent } from '../../components/tablet/tablet-home.component';

/**
 * Home route entry — a thin shell that forks the desktop vs mobile view trees
 * via @defer on LayoutService.isDesktop(), so each device only downloads its
 * own shell chunk. App bootstrap (profile / token / websocket) lives here
 * because this route component is always instantiated regardless of device.
 */
@Component({
  selector: 'app-home',
  imports: [DesktopHomeComponent, TabletHomeComponent, MobileHomeComponent],
  template: `
    @defer (when layout.mode()==='desktop') {
      <app-desktop-home />
    } @defer (when layout.mode()==='tablet') {
      <app-tablet-home />
    } @defer (when layout.mode()==='mobile') {
      <app-mobile-home />
    }
  `,
})
export class HomeComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly userService = inject(UserService);
  private readonly authService = inject(AuthService);
  private readonly wsService = inject(WebsocketService);

  ngOnInit() {
    this.userService.updateSessionProfile();
    // 必须 subscribe：HttpClient.post 是冷 Observable，不订阅不会发请求。
    // 不订阅则 renew-access 不发 → access token 拿不到 → 拦截器挂起所有受保护请求，
    // 直到 setTimerToRefresh 的 setTimeout 兜底触发 renewRefreshToken 才解锁（表现为启动卡几秒）。
    this.authService.renewAccessToken().subscribe();
    // 单例 constructor 不会在登出后重登时再跑，需在此重连 WS
    this.wsService.connect();
  }
}
