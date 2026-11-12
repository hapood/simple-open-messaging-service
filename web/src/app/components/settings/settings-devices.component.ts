import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { ToastService } from '../../services/toast.service';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { forkJoin, firstValueFrom } from 'rxjs';
import dayjs from 'dayjs';
import {
  AuthService,
  type AutoTerminateDays,
  type SessionClient,
  type SessionInfo,
} from '../../services/auth.service';
import { RouteService, PopupType } from '../../services/route.service';
import { LanguageService } from '../../services/language.service';
import { QrScannerService } from '../../services/qr-scanner.service';
import { isAndroidNative } from '../../services/runtime';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { AsyncStateComponent } from '../async-state/async-state.component';
import { SessionDetailsDialogComponent } from './session-details-dialog.component';

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
  imports: [
    MatButtonModule,
    MatProgressSpinnerModule,
    MatCardModule,
    MatSelectModule,
    IconComponent,
    TranslocoPipe,
    AsyncStateComponent,
  ],
  templateUrl: './settings-devices.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings-devices.component.scss',
})
export class SettingsDevicesComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(RouteService);
  private readonly qrScanner = inject(QrScannerService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly toastService = inject(ToastService);
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);

  readonly AppIconType = AppIconType;
  protected readonly isAndroidNative = isAndroidNative;
  readonly list = signal<SessionInfo[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly savingDays = signal<AutoTerminateDays | null>(null);
  readonly autoTerminateDays = signal<AutoTerminateDays | null>(null);
  readonly autoTerminateOptions: readonly AutoTerminateDays[] = [
    7, 30, 90, 180, 365,
  ];
  private loadVersion = 0;

  /** Count of sessions other than the current one — drives the "sign out everywhere else" affordance. */
  readonly othersCount = computed(
    () => this.list().filter((s) => !s.isCurrent).length,
  );
  readonly currentSessions = computed(() =>
    this.list().filter((s) => s.isCurrent),
  );
  readonly otherSessions = computed(() =>
    this.list().filter((s) => !s.isCurrent),
  );

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    const version = ++this.loadVersion;
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin({
      sessions: this.auth.getSessions(),
      settings: this.auth.getSessionSettings(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ sessions, settings }) => {
          if (version !== this.loadVersion) return;
          if (sessions.code === 0 && settings.code === 0 && settings.data) {
            this.list.set(sessions.data ?? []);
            this.autoTerminateDays.set(settings.data.autoTerminateDays);
            this.loading.set(false);
          } else {
            this.loading.set(false);
            this.loadError.set(true);
          }
        },
        error: () => {
          if (version !== this.loadVersion) return;
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  setAutoTerminateDays(days: AutoTerminateDays): void {
    if (this.savingDays() !== null || days === this.autoTerminateDays()) return;
    this.savingDays.set(days);
    this.auth
      .setSessionAutoTerminateDays(days)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.savingDays.set(null);
          if (res.code === 0) this.load();
          else this.toast('session.autoTerminateSaveFailed');
        },
        error: () => {
          this.savingDays.set(null);
          this.toast('session.autoTerminateSaveFailed');
        },
      });
  }

  autoTerminateLabel(days: AutoTerminateDays): string {
    return this.transloco.translate(`session.autoTerminate${days}`);
  }

  /** Localized client badge label (re-renders on a language switch). */
  clientLabel(c: SessionClient): string {
    void this.language.lang();
    const key =
      c === 'app'
        ? 'session.clientApp'
        : c === 'desktop'
          ? 'session.clientDesktop'
          : 'session.clientWeb';
    return this.transloco.translate(key);
  }

  /** Device label: "This device" for the current session, the reported name, or "Unknown device". */
  deviceLabel(s: SessionInfo): string {
    void this.language.lang();
    if (s.isCurrent) return this.transloco.translate('common.thisDevice');
    return s.device || this.transloco.translate('common.unknownDevice');
  }

  /** Date/time formatted via dayjs in the app language locale (set globally by LanguageService). */
  fmt(ts: number): string {
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

  showDetails(s: SessionInfo): void {
    this.dialog.open(SessionDetailsDialogComponent, {
      data: {
        device: this.deviceLabel(s),
        client: this.clientLabel(s.client),
        userAgent: s.userAgent,
        ip: this.location(s),
        signedIn: this.fmt(s.createdAt),
        lastActive: this.fmt(s.lastSeenAt),
        expires: this.expiresLabel(s),
        isCurrent: s.isCurrent,
      },
      panelClass: 'session-details-dialog',
      width: '420px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: false,
    });
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
        if (ok)
          this.auth.revokeSession(s.id).subscribe({ next: () => this.load() });
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
        forkJoin(others.map((o) => this.auth.revokeSession(o.id))).subscribe({
          next: () => this.load(),
        });
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
      {
        messageKey: 'session.linkDeviceConfirm',
        confirmKey: 'session.linkDeviceAuthorize',
      },
      (ok) => {
        if (!ok) return;
        this.auth.qrConfirm(content).subscribe({
          next: (res) =>
            this.toast(
              res.code === 0
                ? 'session.linkDeviceSuccess'
                : 'session.linkDeviceFailed',
            ),
          error: () => this.toast('session.linkDeviceFailed'),
        });
      },
    );
  }

  private toast(key: string): void {
    this.toastService.warn(this.transloco.translate(key), {
      duration: 3000,
    });
  }
}
