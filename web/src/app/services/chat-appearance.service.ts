import { effect, Injectable, signal } from '@angular/core';

const SHOW_SELF_AVATAR_KEY = 'soms.chat.showSelfAvatar';

/**
 * Device-local chat appearance preferences. Message rows are mounted outside the normal Angular view tree,
 * so preferences are also reflected onto `<html>` and existing rows can update through CSS without rebuilding.
 */
@Injectable({ providedIn: 'root' })
export class ChatAppearanceService {
  private readonly _showSelfAvatar = signal(this.readBoolean(SHOW_SELF_AVATAR_KEY, false));

  readonly showSelfAvatar = this._showSelfAvatar.asReadonly();

  constructor() {
    this.applySelfAvatar(this._showSelfAvatar());
    effect(() => this.applySelfAvatar(this._showSelfAvatar()));
  }

  setShowSelfAvatar(show: boolean): void {
    this._showSelfAvatar.set(show);
    try {
      localStorage.setItem(SHOW_SELF_AVATAR_KEY, String(show));
    } catch {
      // Storage may be unavailable in private mode; the in-memory preference still applies.
    }
  }

  private applySelfAvatar(show: boolean): void {
    document.documentElement.setAttribute('data-show-self-avatar', String(show));
  }

  private readBoolean(key: string, fallback: boolean): boolean {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === 'true';
    } catch {
      return fallback;
    }
  }
}
