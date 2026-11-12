import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslocoPipe } from '@jsverse/transloco';
import { takeUntil, timeout } from 'rxjs';
import { AppIconType, IconComponent } from '../icon/icon.component';
import { QrCodeComponent } from '../qr-code/qr-code.component';
import { AuthService } from '../../services/auth.service';
import { ServerConfigDialogService } from '../../services/server-config-dialog.service';
import { sessionClient } from '../../services/runtime';

type QrView = 'loading' | 'pending' | 'scanned' | 'error';

@Component({
  selector: 'app-qr-stage',
  standalone: true,
  imports: [
    IconComponent,
    QrCodeComponent,
    TranslocoPipe,
    MatButtonModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './qr-stage.component.html',
  styleUrl: './qr-stage.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrStageComponent implements OnInit, OnDestroy {
  readonly onSuccess = output<boolean>();

  protected readonly AppIcon = AppIconType;
  protected readonly QR_WARN_SEC = 15;

  private static readonly POLL_INTERVAL_MS = 1500;
  private static readonly POLL_ERROR_DELAY_MS = 3000;
  private static readonly REQUEST_TIMEOUT_MS = 5000;
  private static readonly EXPIRY_REFRESH_DELAY_MS = 300;
  private static readonly CREATE_RETRY_BASE_MS = 1000;
  private static readonly MAX_CREATE_RETRIES = 3;

  private readonly auth = inject(AuthService);
  private readonly serverConfigDialog = inject(ServerConfigDialogService);
  private readonly destroyRef = inject(DestroyRef);

  readonly qrToken = signal<string | null>(null);
  readonly view = signal<QrView>('loading');
  readonly qrRemainingPct = signal(100);
  readonly qrRemainingSec = signal(0);
  readonly qrRemainingText = computed(() => {
    const seconds = Math.max(0, this.qrRemainingSec());
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });

  private pollTimer?: ReturnType<typeof setTimeout>;
  private countdownTimer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private consecutiveCreateFailures = 0;
  private qrDeadline = 0;
  private qrTotalMs = 1;

  ngOnInit(): void {
    this.serverConfigDialog.opened$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.stopPoll();
        this.stopCountdown();
        this.stopRefresh();
        this.qrToken.set(null);
      });
    this.serverConfigDialog.closed$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.retry());
    this.start();
  }

  ngOnDestroy(): void {
    this.stopPoll();
    this.stopCountdown();
    this.stopRefresh();
  }

  retry(): void {
    this.consecutiveCreateFailures = 0;
    this.start();
  }

  private start(): void {
    this.stopCountdown();
    this.stopRefresh();
    this.view.set('loading');
    this.auth
      .qrCreate(sessionClient())
      .pipe(
        timeout(QrStageComponent.REQUEST_TIMEOUT_MS),
        takeUntilDestroyed(this.destroyRef),
        takeUntil(this.serverConfigDialog.opened$),
      )
      .subscribe({
        next: (res) => {
          if (res.code === 0 && res.data) {
            this.consecutiveCreateFailures = 0;
            this.qrToken.set(res.data.qrToken);
            this.qrDeadline = res.data.expiresAt;
            this.qrTotalMs = Math.max(1, res.data.expiresAt - Date.now());
            this.qrRemainingPct.set(100);
            this.qrRemainingSec.set(Math.ceil(this.qrTotalMs / 1000));
            this.view.set('pending');
            this.beginCountdown();
            this.beginPoll();
          } else {
            this.handleCreateFailure();
          }
        },
        error: () => this.handleCreateFailure(),
      });
  }

  private handleCreateFailure(): void {
    this.consecutiveCreateFailures += 1;
    if (this.consecutiveCreateFailures > QrStageComponent.MAX_CREATE_RETRIES) {
      this.consecutiveCreateFailures = 0;
      this.view.set('error');
      return;
    }
    this.view.set('loading');
    const delay =
      QrStageComponent.CREATE_RETRY_BASE_MS * this.consecutiveCreateFailures;
    this.refreshTimer = setTimeout(() => this.start(), delay);
  }

  private refreshAfterExpiry(): void {
    this.stopPoll();
    this.stopCountdown();
    this.qrToken.set(null);
    this.qrRemainingPct.set(0);
    this.qrRemainingSec.set(0);
    this.view.set('loading');
    this.refreshTimer = setTimeout(
      () => this.start(),
      QrStageComponent.EXPIRY_REFRESH_DELAY_MS,
    );
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private beginPoll(): void {
    const token = this.qrToken();
    if (!token) return;
    this.stopPoll();
    this.polling = true;
    this.schedulePoll(token, QrStageComponent.POLL_INTERVAL_MS);
  }

  private schedulePoll(token: string, delay: number): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => {
      if (!this.polling) return;
      this.pollTimer = undefined;
      this.auth
        .qrPoll(token)
        .pipe(
          timeout(QrStageComponent.REQUEST_TIMEOUT_MS),
          takeUntilDestroyed(this.destroyRef),
          takeUntil(this.serverConfigDialog.opened$),
        )
        .subscribe({
          next: (res) => {
            if (res.code === 0 && res.data?.session_token) {
              this.stopPoll();
              this.onSuccess.emit(!!res.data?.mustChangePassword);
            } else if (res.code === 0 && res.data?.status === 'scanned') {
              this.view.set('scanned');
            } else if (res.code === 0 && res.data?.status === 'expired') {
              this.refreshAfterExpiry();
            }
          },
          error: () =>
            this.schedulePoll(token, QrStageComponent.POLL_ERROR_DELAY_MS),
          complete: () =>
            this.schedulePoll(token, QrStageComponent.POLL_INTERVAL_MS),
        });
    }, delay);
  }

  private stopPoll(): void {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private beginCountdown(): void {
    this.stopCountdown();
    this.tickCountdown();
    this.countdownTimer = setInterval(() => this.tickCountdown(), 250);
  }

  private tickCountdown(): void {
    const remaining = this.qrDeadline - Date.now();
    if (remaining <= 0) {
      this.refreshAfterExpiry();
      return;
    }
    this.qrRemainingPct.set(Math.min(100, (remaining / this.qrTotalMs) * 100));
    this.qrRemainingSec.set(Math.ceil(remaining / 1000));
  }

  private stopCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }
}
