import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  PushProbeService,
  type PushProbeStatus,
} from '../../services/push-probe.service';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';

/** Bounded, user-triggered diagnostics only; never a background subscription poll. */
@Component({
  selector: 'app-settings-push-probe',
  imports: [MatButtonModule, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="probe-row">
      <span>{{ 'settings.pushProbeTitle' | transloco }}</span>
      <button
        mat-button
        type="button"
        (click)="run()"
        [disabled]="disabled() || checking() || cooldownRemaining() > 0"
      >
        @if (checking()) {
          {{ 'settings.pushProbeChecking' | transloco }}
        } @else if (cooldownRemaining() > 0) {
          {{ cooldownRemaining() }}s
        } @else {
          {{ 'settings.pushProbeButton' | transloco }}
        }
      </button>
    </div>
    <p role="status" aria-live="polite">
      {{
        'settings.pushProbe_' + (stage() ?? 'idle')
          | transloco: { ms: latencyMs(), error: error() }
      }}
    </p>
    <p class="hint">{{ 'settings.pushProbeDisclaimer' | transloco }}</p>
  `,
  styles: `
    :host {
      display: block;
      padding: 16px;
    }
    .probe-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      line-height: 24px;
    }
    p {
      margin: 8px 0 0;
      line-height: 20px;
      overflow-wrap: anywhere;
    }
    .hint {
      opacity: 0.7;
    }
  `,
})
export class SettingsPushProbeComponent {
  readonly disabled = input(false);
  readonly checking = signal(false);
  readonly cooldownRemaining = signal(0);
  readonly stage = signal<PushProbeStatus['stage'] | 'timeout' | null>(null);
  readonly latencyMs = signal(0);
  readonly error = signal('');
  private readonly probes = inject(PushProbeService);
  private readonly lifecycle = inject(SessionLifecycleService);
  private generation = 0;
  private cooldownTimer?: ReturnType<typeof setInterval>;
  private delayTimer?: ReturnType<typeof setTimeout>;
  private resumeDelay?: () => void;

  constructor() {
    this.lifecycle.invalidated$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.stop());
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  private stop(): void {
    this.generation++;
    clearInterval(this.cooldownTimer);
    clearTimeout(this.delayTimer);
    this.resumeDelay?.();
    this.checking.set(false);
    this.cooldownRemaining.set(0);
    this.stage.set(null);
    this.error.set('');
  }

  async run(): Promise<void> {
    if (this.disabled() || this.checking() || this.cooldownRemaining() > 0)
      return;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.checking.set(true);
    this.stage.set(null);
    this.error.set('');
    const cooldownEnd = Date.now() + 30000;
    this.cooldownRemaining.set(30);
    this.cooldownTimer = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.ceil((cooldownEnd - Date.now()) / 1000),
      );
      this.cooldownRemaining.set(remaining);
      if (!remaining) clearInterval(this.cooldownTimer);
    }, 1000);
    let deadline = Infinity;
    try {
      let status = await this.probes.create();
      deadline = Date.now() + 15000;
      while (current()) {
        this.stage.set(status.stage);
        this.latencyMs.set(status.latencyMs ?? 0);
        this.error.set(status.errorCode ?? '');
        if (status.stage !== 'provider_accepted') return;
        if (Date.now() >= deadline) {
          this.stage.set('timeout');
          return;
        }
        await new Promise<void>((resolve) => {
          this.resumeDelay = resolve;
          this.delayTimer = setTimeout(resolve, 1000);
        });
        if (!current()) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          this.stage.set('timeout');
          return;
        }
        status = await this.probes.get(status.probeId, remaining);
      }
    } catch (e) {
      if (current()) {
        if (Date.now() >= deadline) {
          this.stage.set('timeout');
          return;
        }
        const problem = e as { error?: { message?: string }; message?: string };
        this.error.set(
          problem.error?.message ?? problem.message ?? 'Unknown error',
        );
        this.stage.set('failed');
      }
    } finally {
      if (current()) this.checking.set(false);
    }
  }
}
