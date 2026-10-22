import { Injectable, signal } from '@angular/core';
import { apiOriginIsEmpty, getActiveApiOrigin, isTauri, tauriInvoke } from './runtime';

export interface ClientCompatStatus {
  serverVersion: string;
  incompatible: boolean;
}

/** Read-only server information for the installed client. */
@Injectable({ providedIn: 'root' })
export class ClientCompatService {
  readonly status = signal<ClientCompatStatus | null>(null);
  readonly probedOrigin = signal('');

  async check(): Promise<void> {
    if (!isTauri() || apiOriginIsEmpty()) return;
    try {
      const origin = await getActiveApiOrigin();
      this.status.set(await tauriInvoke<ClientCompatStatus>('init_compat_status', { origin }));
      this.probedOrigin.set(origin);
    } catch (e) {
      console.warn('client compatibility probe failed', e);
    }
  }
}
