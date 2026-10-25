import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Owns the optional server-settings overlay shown from the authentication flow.
 *
 * First-run setup remains route-guarded and non-dismissible; this service is only
 * for an already-configured client temporarily editing its connection settings.
 */
@Injectable({ providedIn: 'root' })
export class ServerConfigDialogService {
  private readonly visibleState = signal(false);

  private readonly opened = new Subject<void>();
  private readonly closed = new Subject<void>();
  readonly opened$ = this.opened.asObservable();
  readonly closed$ = this.closed.asObservable();

  readonly visible = this.visibleState.asReadonly();

  open(): void {
    if (this.visibleState()) return;
    this.visibleState.set(true);
    this.opened.next();
  }

  close(): void {
    if (!this.visibleState()) return;
    this.visibleState.set(false);
    this.closed.next();
  }
}
