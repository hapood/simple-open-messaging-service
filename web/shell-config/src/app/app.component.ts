import { ChangeDetectionStrategy, Component, computed, afterNextRender, signal, inject, DestroyRef } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslocoModule } from '@jsverse/transloco';
import { canonicalOrigin, emitTauriEvent, listenEvent, originIsInsecure, tauriInvoke } from './tauri';

/** The bootstrap's 3-step init flow phase, surfaced as a determinate progress value + a step label. */
type Phase = 'form' | 'compat' | 'cert' | 'download' | 'done' | 'error';

/** Byte-progress payload Rust emits as `web-download-progress` while streaming the web bundle. */
interface DownloadProgress {
  received: number;
  total: number | null;
}

/**
 * The bundled `init` window — first-run setup wizard AND reconfigure UI. A thin orchestrator over the
 * Rust `init_*` commands: read state (init_get_state) → show the server-URL form → on save run the 3
 * steps (init_check_compat → init_validate_cert → init_download_web) with a progress bar → hand off to
 * the SPA (handoff_to_spa, which Rust uses to create/reload the main window + destroy this one). Emits
 * `init-ready` after first paint so Rust can show this window with no blank gap (the app-shell spinner
 * covers the pre-paint frame).
 *
 * Download phase: Rust streams the bundle and emits `web-download-progress` {received, total}; this
 * component maps that onto the 67→90 slice of the bar so it advances smoothly instead of freezing at
 * 90% until the (few-MB) download finishes.
 */
@Component({
  selector: 'sc-root',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    TranslocoModule,
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly destroyRef = inject(DestroyRef);
  readonly url = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required],
  });
  readonly phase = signal<Phase>('form');
  /** The live origin value the insecure-warning + cert-skip note react to. */
  readonly origin = signal('');
  readonly errorKey = signal<string>('');
  /** Byte-progress state for the download phase, fed by the `web-download-progress` Tauri event. */
  readonly downloadReceived = signal(0);
  readonly downloadTotal = signal<number | null>(null);
  readonly busy = computed(() => this.phase() !== 'form' && this.phase() !== 'error');
  readonly insecure = computed(() => originIsInsecure(this.origin()));
  private readonly progressByPhase: Record<Phase, number> = {
    form: 0,
    compat: 34,
    cert: 67,
    download: 90,
    done: 100,
    error: 0,
  };
  /** The bar value. During download it maps the live byte ratio onto the 67→90 band (the download
   *  phase's slice) so the bar advances smoothly instead of freezing at 90%; without a Content-Length
   *  it sits at the band start (the readout then shows received MB). */
  readonly progress = computed(() => {
    if (this.phase() === 'download') {
      const total = this.downloadTotal();
      if (total && total > 0) {
        return 67 + Math.round((this.downloadReceived() / total) * 23);
      }
      return 67;
    }
    return this.progressByPhase[this.phase()];
  });
  /** transloco key for the current step label (empty when on the form). */
  readonly stepKey = computed(() => {
    switch (this.phase()) {
      case 'compat':
        return 'sc.step.compat';
      case 'cert':
        return 'sc.step.cert';
      case 'download':
        return 'sc.step.download';
      case 'done':
        return 'sc.step.done';
      default:
        return '';
    }
  });
  /** Live numeric readout under the bar during download: percentage when the size is known, received
   *  bytes otherwise (the indeterminate fallback for chunked transfers with no Content-Length). */
  readonly downloadLabel = computed(() => {
    if (this.phase() !== 'download') return '';
    const total = this.downloadTotal();
    const received = this.downloadReceived();
    if (total && total > 0) return `${Math.round((received / total) * 100)}%`;
    return formatBytes(received);
  });

  constructor() {
    // Emit init-ready after the first paint so Rust shows this window (no blank gap before the form).
    afterNextRender(() => emitTauriEvent('init-ready'));
    this.url.valueChanges.subscribe((v) => this.origin.set(v));
    this.registerProgressListener();
    void this.bootstrap();
  }

  /** Read state; pre-fill the origin. If already initialized (not a reconfigure), hand straight back. */
  private async bootstrap(): Promise<void> {
    try {
      const state = await tauriInvoke<{ origin: string; hasWeb: boolean; reconfigure: boolean }>(
        'init_get_state',
      );
      if (state.origin) {
        this.url.setValue(state.origin);
        this.origin.set(state.origin);
      }
      if (!state.reconfigure && state.origin && state.hasWeb) {
        await tauriInvoke('handoff_to_spa');
      }
    } catch {
      /* show the form anyway — the user can configure a server */
    }
  }

  /** Subscribe once to the Rust stream-download byte-progress event; unlisten on destroy. Ignored
   *  outside the download phase (the handler early-returns when phase !== 'download'). */
  private registerProgressListener(): void {
    void (async () => {
      const unlisten = await listenEvent<DownloadProgress>('web-download-progress', (e) => {
        if (this.phase() !== 'download') return;
        this.downloadReceived.set(e.payload.received);
        this.downloadTotal.set(e.payload.total);
      });
      if (unlisten) this.destroyRef.onDestroy(unlisten);
    })();
  }

  async save(): Promise<void> {
    const raw = canonicalOrigin(this.url.value);
    if (!raw) {
      this.url.markAsTouched();
      return;
    }
    this.errorKey.set('');
    this.downloadReceived.set(0);
    this.downloadTotal.set(null);
    try {
      this.phase.set('compat');
      await tauriInvoke('init_check_compat', { origin: raw });
      this.phase.set('cert');
      await tauriInvoke('init_validate_cert', { origin: raw });
      this.phase.set('download');
      await tauriInvoke('init_download_web', { origin: raw });
      this.phase.set('done');
      await tauriInvoke('handoff_to_spa');
    } catch (e) {
      this.errorKey.set(this.errorKeyFor(e, raw));
      this.phase.set('error');
    }
  }

  /** Map the failing step → the matching i18n error key (the step that threw is the current phase). */
  private errorKeyFor(e: unknown, origin: string): string {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    if (lower.includes('compat') || lower.includes('too old') || lower.includes('not compatible')) {
      return 'sc.compatErr';
    }
    if (lower.includes('cert') || lower.includes('self-signed') || lower.includes('expired')) {
      void origin;
      return 'sc.certErr';
    }
    return 'sc.downloadErr';
  }

  /** Reset to the form after an error so the user can edit + retry. */
  back(): void {
    this.phase.set('form');
    this.errorKey.set('');
  }
}

/** Format a byte count as a short human string (e.g. `1.2 MB`). Used by the download readout's
 *  indeterminate fallback (chunked transfer, no Content-Length). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
