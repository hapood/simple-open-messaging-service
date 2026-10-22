import { Injectable } from '@angular/core';

export type AppBackHandler = () => void;

/** Stable Web entry point for Android Back, with lifecycle-scoped handlers in last-in-first-out order. */
@Injectable({ providedIn: 'root' })
export class AppBackDispatcherService {
  private readonly handlers: Array<{ readonly id: number; readonly handle: AppBackHandler }> = [];
  private nextId = 0;
  private fallback?: AppBackHandler;

  constructor() {
    window.__SOMS_BACK__ = () => this.dispatch();
  }

  setFallback(handler: AppBackHandler): void {
    this.fallback = handler;
  }

  register(handler: AppBackHandler): () => void {
    const id = this.nextId++;
    this.handlers.push({ id, handle: handler });
    return () => {
      const index = this.handlers.findIndex((entry) => entry.id === id);
      if (index !== -1) this.handlers.splice(index, 1);
    };
  }

  private dispatch(): void {
    const top = this.handlers.at(-1);
    if (top) top.handle();
    else this.fallback?.();
  }
}
