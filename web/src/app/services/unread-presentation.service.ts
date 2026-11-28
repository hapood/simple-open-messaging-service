import { Injectable, inject, signal } from '@angular/core';
import { ForegroundPresentation } from './foreground-presentation.service';

/** Ephemeral viewport facts only. Never writes counts, read cursors or entry boundaries. */
@Injectable({ providedIn: 'root' })
export class UnreadPresentation {
  private readonly foreground = inject(ForegroundPresentation);
  private readonly surfaces = signal(new Map<object, number>());

  report(
    owner: object,
    threadId: number | undefined,
    foreground: boolean,
    pinned: boolean,
  ): void {
    this.surfaces.update((surfaces) => {
      const next = new Map(surfaces);
      if (threadId !== undefined && foreground && pinned)
        next.set(owner, threadId);
      else next.delete(owner);
      return next;
    });
  }

  clear(owner: object): void {
    this.report(owner, undefined, false, false);
  }

  suppresses(threadId: number): boolean {
    return (
      this.foreground.focused() &&
      [...this.surfaces().values()].includes(threadId)
    );
  }
}
