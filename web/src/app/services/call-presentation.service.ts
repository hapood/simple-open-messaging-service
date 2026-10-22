import { Injectable, signal } from '@angular/core';

/** Owns call chrome presentation independently from the call/media lifecycle. */
@Injectable({ providedIn: 'root' })
export class CallPresentationService {
  readonly minimized = signal(false);

  minimize(): void {
    this.minimized.set(true);
  }

  restore(): void {
    this.minimized.set(false);
  }
}
