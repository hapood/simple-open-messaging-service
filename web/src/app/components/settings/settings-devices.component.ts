import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { forkJoin } from 'rxjs';
import dayjs from 'dayjs';
import { AuthService, type SessionClient, type SessionInfo } from '../../services/auth.service';
import { RouteService, PopupType } from '../../services/route.service';
import { LanguageService } from '../../services/language.service';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * Settings → Devices sub-page: the "where am I logged in" list (industry-standard session management —
 * one Telegram/GitHub-style surface, shared by web + desktop + the Android WebView app).
 *
 * Each row shows the device label, a client badge (Android/Web/Desktop — or a "This device" tag for the
 * requesting session, server-stamped via `isCurrent`), the user agent, the sign-in + last-active times,
 * the IP, and the expiry (no-expiry app tokens read "No expiry"). Non-current rows have a Revoke action;
 * a "sign out everywhere else" action revokes every other session in one shot. Both confirm first.
 *
 * Body-only: the host (mobile aside or desktop dialog) provides the panel shell + header. All vertical
 * metrics are integer px (project rule).
 */
@Component({
  selector: 'app-settings-devices',
  imports: [MatButtonModule, IconComponent, TranslocoPipe],
  templateUrl: './settings-devices.component.html',
  styleUrl: './settings-devices.component.scss',
})
export class SettingsDevicesComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(RouteService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  readonly AppIconType = AppIconType;
  readonly list = signal<SessionInfo[]>([]);
  readonly loading = signal(true);

  /** Count of sessions other than the current one — drives the "sign out everywhere else" affordance. */
  readonly othersCount = computed(() => this.list().filter((s) => !s.isCurrent).length);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.auth.getSessions().subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.code === 0) this.list.set(res.data ?? []);
      },
      error: () => this.loading.set(false),
    });
  }

  /** Localized client badge label (re-renders on a language switch). */
  clientLabel(c: SessionClient): string {
    void this.language.lang();
    const key = c === 'app' ? 'session.clientApp' : c === 'desktop' ? 'session.clientDesktop' : 'session.clientWeb';
    return this.transloco.translate(key);
  }

  /** Device label: "This device" for the current session, the reported name, or "Unknown device". */
  deviceLabel(s: SessionInfo): string {
    void this.language.lang();
    if (s.isCurrent) return this.transloco.translate('common.thisDevice');
    return s.device || this.transloco.translate('common.unknownDevice');
  }

  /** Date/time formatted via dayjs in the app language locale (set globally by LanguageService). */
  fmt(ts: string): string {
    this.language.lang();
    return dayjs(ts).format('YYYY-MM-DD HH:mm');
  }

  /** Expiry line: "No expiry" for no-expiry app tokens, else the formatted deadline. */
  expiresLabel(s: SessionInfo): string {
    void this.language.lang();
    return s.expiresAt === null
      ? this.transloco.translate('session.neverExpires')
      : this.fmt(s.expiresAt);
  }

  /** Best-effort location IP: prefer the most recent (lastSeenIp), fall back to the sign-in IP. */
  location(s: SessionInfo): string {
    return s.lastSeenIp || s.ip || '-';
  }

  /** Revoke one session (confirm first). Ownership is verified server-side; on success the list reloads. */
  revoke(s: SessionInfo): void {
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        messageKey: 'session.revokeConfirm',
        messageParams: { device: this.deviceLabel(s) },
        confirmKey: 'session.revoke',
        danger: true,
      },
      (ok) => {
        if (ok) this.auth.revokeSession(s.id).subscribe({ next: () => this.load() });
      },
    );
  }

  /** Revoke every session except the current one (confirm first). Issued in parallel; reloads on done. */
  terminateOthers(): void {
    const others = this.list().filter((s) => !s.isCurrent);
    if (others.length === 0) return;
    this.route.popupDlg(
      PopupType.CONFIRM,
      {
        messageKey: 'session.terminateOthersConfirm',
        messageParams: { count: others.length },
        confirmKey: 'session.terminateOthers',
        danger: true,
      },
      (ok) => {
        if (!ok) return;
        forkJoin(others.map((o) => this.auth.revokeSession(o.id))).subscribe({ next: () => this.load() });
      },
    );
  }
}
