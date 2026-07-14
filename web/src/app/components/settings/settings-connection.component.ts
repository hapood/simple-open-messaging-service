import { Component, computed, inject, signal } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';
import { apiPrefix } from '../../services/constants';

/** Result of a manual server-health probe. */
interface HealthResult {
  ok: boolean;
  version?: string;
  ms?: number;
  error?: string;
}

/**
 * Settings → Connection sub-page. Two diagnostics rows:
 *
 *  1. Realtime connection — the authenticated SSE stream that delivers live messages. Its
 *     {@link WebsocketService.state} is shown as a colored pill (green=open, amber=connecting/
 *     reconnecting, muted=closed), with a Retry button that calls {@link WebsocketService.retryNow}
 *     (skips the worker's backoff — for impatience; the stream auto-reconnects on its own).
 *  2. Server health — a manual liveness probe against the public `GET /api/v1/health` (no sign-in
 *     needed). Reports reachable/unreachable with the server version + round-trip latency. Deliberately
 *     INDEPENDENT of the SSE stream: health can be OK while the authenticated stream is reconnecting
 *     (e.g. a stale token mid-renew), and the stream can be open while health is unchecked.
 *
 * Body-only: the host (mobile aside or desktop dialog) provides the panel shell + category list. The
 * trailing pill+button cluster on each row sits in a single `<div matListItemMeta>` so the whole group
 * projects into the MDC list-item `__end` slot (multiple bare children would land in the primary content
 * slot — the crooked-toggle bug). All vertical metrics are integer px (project rule).
 */
@Component({
  selector: 'app-settings-connection',
  imports: [MatListModule, MatButtonModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <!-- Realtime connection (SSE) -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.realtimeConnection' | transloco }}</span>
            <span matListItemLine class="hint">{{ 'settings.realtimeDesc' | transloco }}</span>
            <div matListItemMeta class="row-actions">
              <span class="status-pill"
                    [class.active]="connPillClass() === 'active'"
                    [class.warn]="connPillClass() === 'warn'">{{ connLabel() }}</span>
              <button mat-button type="button" class="check-btn"
                      (click)="retry()" [disabled]="!canRetry()">
                {{ 'settings.retry' | transloco }}
              </button>
            </div>
          </mat-list-item>

          <!-- Server health (liveness probe) -->
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.serverHealth' | transloco }}</span>
            <span matListItemLine class="hint">{{ healthHint() }}</span>
            <div matListItemMeta class="row-actions">
              <span class="status-pill"
                    [class.active]="healthPillClass() === 'active'"
                    [class.error]="healthPillClass() === 'error'">{{ healthPillLabel() }}</span>
              <button mat-button type="button" class="check-btn"
                      (click)="check()" [disabled]="checking()">
                {{ (checking() ? 'settings.healthChecking' : 'settings.healthCheck') | transloco }}
              </button>
            </div>
          </mat-list-item>
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsConnectionComponent {
  private readonly ws = inject(WebsocketService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** Last health-probe result, or null before the first check. */
  readonly health = signal<HealthResult | null>(null);
  /** True while a health probe is in flight (disables the button + shows the "Checking…" label). */
  readonly checking = signal(false);

  // ── Realtime connection ────────────────────────────────────────────────────────────────────

  /** Localized state label for the pill (re-renders on language switch). */
  readonly connLabel = computed(() => {
    void this.language.lang();
    return this.transloco.translate(this.connKey(this.ws.state()));
  });
  /** Pill color: green when open, amber while connecting/reconnecting, muted when closed. */
  readonly connPillClass = computed<string>(() => {
    switch (this.ws.state()) {
      case 'open':
        return 'active';
      case 'connecting':
      case 'reconnecting':
        return 'warn';
      default:
        return ''; // 'closed'
    }
  });
  /** Retry is meaningful only mid-(re)connect — retryNow is a no-op when open or closed. */
  readonly canRetry = computed(
    () => this.ws.state() === 'connecting' || this.ws.state() === 'reconnecting',
  );

  private connKey(s: ConnectionState): string {
    switch (s) {
      case 'open':
        return 'settings.connStatusOpen';
      case 'connecting':
        return 'settings.connStatusConnecting';
      case 'reconnecting':
        return 'settings.connStatusReconnecting';
      default:
        return 'settings.connStatusClosed';
    }
  }

  /** Skip the worker's backoff and reconnect at once (no-op unless mid-(re)connect). */
  retry(): void {
    this.ws.retryNow();
  }

  // ── Server health ──────────────────────────────────────────────────────────────────────────

  /** Short pill label: idle / OK / failed (re-renders on language switch). */
  readonly healthPillLabel = computed(() => {
    void this.language.lang();
    const h = this.health();
    if (!h) return this.transloco.translate('settings.healthIdle');
    return this.transloco.translate(h.ok ? 'settings.healthOkShort' : 'settings.healthFailShort');
  });

  readonly healthPillClass = computed<string>(() => {
    const h = this.health();
    if (!h) return ''; // idle → muted
    return h.ok ? 'active' : 'error';
  });

  /** Detail line: the default description, or the version + latency / error from the last probe. */
  readonly healthHint = computed(() => {
    void this.language.lang();
    const h = this.health();
    if (!h) return this.transloco.translate('settings.healthDesc');
    if (h.ok) {
      return this.transloco.translate('settings.healthOkDetail', {
        version: h.version ?? '?',
        ms: h.ms ?? '?',
      });
    }
    return this.transloco.translate('settings.healthFailDetail', { error: h.error ?? '' });
  });

  /** Probe `GET /api/v1/health` (public), measure round-trip latency, store the result. `fetch` (not
   *  HttpClient) on purpose: it's a public endpoint, so bypassing the auth interceptor is correct and
   *  keeps this independent of the authenticated SSE stream's state. */
  async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    const t0 = performance.now();
    try {
      const res = await fetch(`${apiPrefix}/health`);
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const version = json?.data?.version ?? '';
      this.health.set({ ok: true, version, ms });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'network';
      this.health.set({ ok: false, error });
    } finally {
      this.checking.set(false);
    }
  }
}
