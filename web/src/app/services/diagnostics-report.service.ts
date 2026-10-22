import { inject, Injectable } from '@angular/core';
import { appVersion } from '../version';
import { flushConsoleBuffer } from './log-buffer';
import { apiOrigin, isAndroid, isTauri, tauriInvoke } from './runtime';
import { ClientCompatService } from './client-compat.service';

export interface DiagnosticsManifest {
  readonly app: string;
  readonly server: string;
  readonly platform: 'android' | 'desktop' | 'web';
  readonly origin: string;
  readonly at: number;
}

/** Shared native diagnostic-bundle uploader used by Settings and the live log panel. */
@Injectable({ providedIn: 'root' })
export class DiagnosticsReportService {
  private readonly clientCompat = inject(ClientCompatService);

  async upload(): Promise<number> {
    const manifest = this.buildManifest();
    // Persist every pending JS console line before Rust reads the durable files into the bundle.
    await flushConsoleBuffer();
    return tauriInvoke<number>('report_diagnostics', { manifest });
  }

  buildManifest(at = Date.now()): DiagnosticsManifest {
    const update = this.clientCompat.status();
    return {
      app: appVersion,
      server: update?.serverVersion ?? '',
      platform: isTauri() ? (isAndroid() ? 'android' : 'desktop') : 'web',
      origin: apiOrigin(),
      at,
    };
  }
}
