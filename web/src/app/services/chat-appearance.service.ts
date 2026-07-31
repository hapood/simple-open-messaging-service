import { effect, Injectable, signal } from '@angular/core';

const SHOW_SELF_AVATAR_KEY = 'soms.chat.showSelfAvatar';
const OPEN_POSITION_KEY = 'soms.chat.openPosition';

export type ChatOpenPosition = 'latest' | 'last-read';

/**
 * Device-local chat appearance preferences. Message rows are mounted outside the normal Angular view tree,
 * so preferences are also reflected onto `<html>` and existing rows can update through CSS without rebuilding.
 */
@Injectable({ providedIn: 'root' })
export class ChatAppearanceService {
  // Default ON: most users expect to see their own avatar alongside their messages. Only a stored preference
  // (a user who explicitly turned it off) overrides this — new users and cleared-storage starts show self avatars.
  private readonly _showSelfAvatar = signal(this.readBoolean(SHOW_SELF_AVATAR_KEY, true));
  private readonly _openPosition = signal<ChatOpenPosition>(this.readOpenPosition());

  readonly showSelfAvatar = this._showSelfAvatar.asReadonly();
  readonly openPosition = this._openPosition.asReadonly();

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

  setOpenPosition(position: ChatOpenPosition): void {
    this._openPosition.set(position);
    try {
      localStorage.setItem(OPEN_POSITION_KEY, position);
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

  private readOpenPosition(): ChatOpenPosition {
    try {
      return localStorage.getItem(OPEN_POSITION_KEY) === 'last-read'
        ? 'last-read'
        : 'latest';
    } catch {
      return 'latest';
    }
  }
}
