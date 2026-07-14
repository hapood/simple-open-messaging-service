import { Injectable, signal } from '@angular/core';

const ENABLED_KEY = 'soms.notifEnabled';
const SOUND_KEY = 'soms.notifSound';

/**
 * App-level notification preferences for the browser in-tab attention path ({@link UnreadAttentionService}).
 * Two booleans, both default `true`, persisted to `localStorage` via the project's `soms.*` idiom — the
 * same ad-hoc-per-service shape as {@link MediaSizeThresholdService} (there is no generic storage helper;
 * each pref domain owns its own wrapper, with a try/catch for private mode).
 *
 * These are DEVICE-level (like theme/language): they survive logout. `UserService.clearSession()` only
 * wipes user-scoped keys (`soms.chatFolders`, `soms.chat.emojiRecents`), so these are preserved.
 *
 *  - `enabled` — app-level master for posting the system notification. When `false`, no notification is
 *    created even if the browser permission is `'granted'`. The browser permission itself is terminal
 *    (`Notification.requestPermission()` has no revoke), so this toggle is the in-app mute the user
 *    controls without digging into the browser's site settings.
 *  - `sound` — whether the notification plays the system sound. Maps to the Notifications API `silent`
 *    flag (`silent: !sound`).
 */
@Injectable({ providedIn: 'root' })
export class NotificationPrefsService {
  private readonly _enabled = signal<boolean>(this.readBool(ENABLED_KEY, true));
  private readonly _sound = signal<boolean>(this.readBool(SOUND_KEY, true));

  /** Whether to post the system notification at all (app-level master; browser permission still required). */
  readonly enabled = this._enabled.asReadonly();
  /** Whether the notification plays the system sound (false → `silent: true`). */
  readonly sound = this._sound.asReadonly();

  setEnabled(enabled: boolean): void {
    this._enabled.set(enabled);
    this.writeBool(ENABLED_KEY, enabled);
  }

  setSound(sound: boolean): void {
    this._sound.set(sound);
    this.writeBool(SOUND_KEY, sound);
  }

  private readBool(key: string, fallback: boolean): boolean {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return fallback;
      return v === '1';
    } catch {
      // localStorage disabled (private mode) — keep the in-memory signal only.
      return fallback;
    }
  }

  private writeBool(key: string, value: boolean): void {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // localStorage disabled (private mode) — keep the in-memory signal only.
    }
  }
}
