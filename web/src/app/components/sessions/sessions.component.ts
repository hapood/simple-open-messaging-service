import { Component, signal, inject, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouteService } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';

type Session = {
  jti: string;
  device: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  expiresAt: number;
};

/**
 * 登录会话管理：列出活跃 refresh 会话（device/UA/IP/登录与过期时间），支持踢出单设备。
 * 数据来自 GET /auth/sessions；踢出调 /auth/revoke-session（jti）。
 */
@Component({
  selector: 'app-sessions',
  imports: [MatButtonModule, IconComponent, FitDialogDirective],
  templateUrl: './sessions.component.html',
  styleUrl: './sessions.component.scss',
})
export class SessionsComponent implements OnInit {
  private readonly routeService = inject(RouteService);
  private readonly authService = inject(AuthService);

  readonly AppIconType = AppIconType;
  readonly fitOpts = { minHeight: 380 } as const;
  readonly list = signal<Session[]>([]);
  readonly loading = signal(true);
  readonly myDevice = localStorage.getItem('device_id');

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.authService.getSessions().subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.code === 0) this.list.set((res.data ?? []) as Session[]);
      },
      error: () => this.loading.set(false),
    });
  }

  revoke(jti: string) {
    this.authService.revokeSession(jti).subscribe({
      next: () => this.load(),
    });
  }

  fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  goBack() {
    this.routeService.closeDlg();
  }
}
