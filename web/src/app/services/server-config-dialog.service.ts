import { Injectable, signal } from '@angular/core';

/**
 * Owns the optional server-settings overlay shown from the authentication flow.
 *
 * First-run setup remains route-guarded and non-dismissible; this service is only
 * for an already-configured client temporarily editing its connection settings.
 */
@Injectable({ providedIn: 'root' })
export class ServerConfigDialogService {
  private readonly visibleState = signal(false);

  readonly visible = this.visibleState.asReadonly();

  open(): void {
    this.visibleState.set(true);
  }

  close(): void {
    this.visibleState.set(false);
  }
}
