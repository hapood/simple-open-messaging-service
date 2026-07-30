import { inject, Injectable } from '@angular/core';
import { appVersion } from '../version';
import { flushConsoleBuffer } from './log-buffer';
import { apiOrigin, isAndroid, isTauri, tauriInvoke } from './runtime';
import { ShellUpdateService } from './shell-update.service';

export interface DiagnosticsManifest {
  readonly app: string;
  readonly web: string;
  readonly shell: string;
  readonly server: string;
  readonly platform: 'android' | 'desktop' | 'web';
  readonly origin: string;
  readonly at: string;
}

/** Shared native diagnostic-bundle uploader used by Settings and the live log panel. */
@Injectable({ providedIn: 'root' })
export class DiagnosticsReportService {
  private readonly shellUpdate = inject(ShellUpdateService);

  async upload(): Promise<number> {
    const manifest = this.buildManifest();
    // Persist every pending JS console line before Rust reads the durable files into the bundle.
    await flushConsoleBuffer();
    return tauriInvoke<number>('report_diagnostics', { manifest });
  }

  buildManifest(at = new Date().toISOString()): DiagnosticsManifest {
    const update = this.shellUpdate.updateStatus();
    return {
      app: appVersion,
      web: update?.installedWebVersion ?? appVersion,
      shell: update?.shellVersion ?? '',
      server: update?.serverVersion ?? '',
      platform: isTauri() ? (isAndroid() ? 'android' : 'desktop') : 'web',
      origin: apiOrigin(),
      at,
    };
  }
}
