import { Injectable } from '@angular/core';

/**
 * Ensures at most one voice clip plays at a time across the whole app (WhatsApp/Telegram behaviour: starting
 * a second clip pauses the first). A root-scoped singleton because voice players are spread across threads
 * and panes, so the "stop the previous" rule must be global, not per-component.
 *
 * Players pass a stable `pause` callback (their own `() => el.pause()`); `begin` pauses the previously-active
 * callback (if different) and records the new one. Pausing an already-ended/already-paused element is a no-op,
 * so a stale active slot is harmless — no explicit unregister is needed. Identity comparison on the callback
 * detects "this player is already active" (re-tap) and avoids pausing oneself.
 */
@Injectable({ providedIn: 'root' })
export class AudioPlaybackCoordinator {
  private active: (() => void) | null = null;

  begin(pause: () => void): void {
    if (this.active && this.active !== pause) this.active();
    this.active = pause;
  }
}
