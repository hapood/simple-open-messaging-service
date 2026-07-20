import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { forkJoin, firstValueFrom } from 'rxjs';
import dayjs from 'dayjs';
import { AuthService, type SessionClient, type SessionInfo } from '../../services/auth.service';
import { RouteService, PopupType } from '../../services/route.service';
import { LanguageService } from '../../services/language.service';
import { QrScannerService } from '../../services/qr-scanner.service';
import { isAndroidNative } from '../../services/runtime';
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
  private readonly qrScanner = inject(QrScannerService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly snackbar = inject(MatSnackBar);

  readonly AppIconType = AppIconType;
  protected readonly isAndroidNative = isAndroidNative;
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

  /** Android-only: authorize sign-in on another device by scanning its QR (the phone side of QR sign-in).
   *  Two-step, mirroring Telegram's "Link Desktop Device": scan the desktop's QR token → mark it scanned
   *  (the desktop shows "confirm on your phone") → confirm → the desktop's next poll receives its 2-week
   *  session. isAndroidNative() gates the whole flow; the scanner (plugin + Angular overlay UI) is
   *  lazy-loaded by QrScannerService so the browser/desktop bundle never loads it. */
  async linkDevice(): Promise<void> {
    if (!isAndroidNative()) return;
    // The scanner overlay resolves with the decoded QR content, or `null` on a benign cancel (Cancel /
    // hardware back / Esc — kept silent). It rejects only on a real failure: camera permission denied, the
    // ML Kit recognition model failing to load (no Google Play Services), a capability rejection, or the
    // lazy chunk failing to load. Surface those — toast + console.error, so they also land in edge://inspect
    // / adb logcat — instead of eating them (which previously made the button look dead).
    let content: string | null;
    try {
      content = await this.qrScanner.open();
    } catch (err) {
      console.error('[linkDevice] barcode scan failed:', err);
      this.toast('session.linkDeviceFailed');
      return;
    }
    if (!content) return; // cancelled — silent
    // Step 1 — mark scanned so the desktop flips to "confirm on your phone".
    const scanRes = await firstValueFrom(this.auth.qrScan(content));
    if (scanRes.code !== 0) {
      this.toast('session.linkDeviceFailed');
      return;
    }
    // Step 2 — confirm: authorize the sign-in (the desktop's next poll mints its session).
    this.route.popupDlg(
      PopupType.CONFIRM,
      { messageKey: 'session.linkDeviceConfirm', confirmKey: 'session.linkDeviceAuthorize' },
      (ok) => {
        if (!ok) return;
        this.auth.qrConfirm(content).subscribe({
          next: (res) => this.toast(res.code === 0 ? 'session.linkDeviceSuccess' : 'session.linkDeviceFailed'),
          error: () => this.toast('session.linkDeviceFailed'),
        });
      },
    );
  }

  private toast(key: string): void {
    this.snackbar.open(this.transloco.translate(key), undefined, { duration: 3000 });
  }
}
