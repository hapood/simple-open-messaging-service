import { Component, signal, inject, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import dayjs from 'dayjs';
import { RouteService } from '../../services/route.service';
import { LanguageService } from '../../services/language.service';
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
 * Login-session management: lists active refresh sessions (device/UA/IP/login + expiry times) and supports
 * revoking a single device. Data comes from GET /auth/sessions; revoking calls /auth/revoke-session (jti).
 */
@Component({
  selector: 'app-sessions',
  imports: [MatButtonModule, IconComponent, FitDialogDirective, TranslocoPipe],
  templateUrl: './sessions.component.html',
  styleUrl: './sessions.component.scss',
})
export class SessionsComponent implements OnInit {
  private readonly routeService = inject(RouteService);
  private readonly authService = inject(AuthService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

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

  /** Session timestamp formatted via dayjs (follows the app language's locale, set globally by
   *  LanguageService — NOT the browser locale). Reads the language signal so the row re-evaluates on a
   *  language switch. */
  fmt(ts: number): string {
    this.language.lang();
    return dayjs(ts).format('YYYY-MM-DD HH:mm');
  }

  /** Localized device label for a session row: "This device" for the current session, the raw device
   *  name when known, or "Unknown device" as a fallback. */
  deviceLabel(s: Session): string {
    if (s.device === this.myDevice) return this.transloco.translate('common.thisDevice');
    return s.device || this.transloco.translate('common.unknownDevice');
  }

  goBack() {
    this.routeService.closeDlg();
  }
}
