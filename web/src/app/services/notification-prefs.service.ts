import { inject, Injectable, signal } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

const ENABLED_KEY = 'notificationEnabled';
const SOUND_KEY = 'notificationSound';
/** Away-notification grouping pref key — "thread" (default) or "all". */
const PREVIEW_MODE_KEY = 'notificationPreviewMode';

/**
 * App-level notification preferences for the browser in-tab attention path ({@link UnreadAttentionService}).
 * Two booleans, both default `true`, persisted device-level via {@link PreferenceStore} — the
 * same shape as {@link MediaSizeThresholdService}.
 *
 * These are DEVICE-level (like theme/language): they survive logout. `UserService.clearSession()` only
 * wipes user-scoped keys such as `soms.chat.emojiRecents`, so these are preserved.
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
  private readonly preferences = inject(PreferenceStore);
  private writeRevision = 0;
  private readonly _enabled = signal(true);
  private readonly _sound = signal(true);
  private readonly _previewMode = signal<'message' | 'private'>('message');

  /** Whether to post the system notification at all (app-level master; browser permission still required). */
  readonly enabled = this._enabled.asReadonly();
  /** Whether the notification plays the system sound (false → `silent: true`). */
  readonly sound = this._sound.asReadonly();
  /** Away-notification grouping — "thread" (one card per conversation, default) or "all" (one folded card). */
  readonly previewMode = this._previewMode.asReadonly();

  constructor() {
    void this.restore();
  }

  setEnabled(enabled: boolean): void {
    this.writeRevision++;
    this._enabled.set(enabled);
    void this.preferences.set('device', ENABLED_KEY, enabled).catch(() => {});
  }

  setSound(sound: boolean): void {
    this.writeRevision++;
    this._sound.set(sound);
    void this.preferences.set('device', SOUND_KEY, sound).catch(() => {});
  }

  /** Set the away-notification grouping pref. The next foreground pull sends it as `grouping`. */
  setPreviewMode(mode: 'message' | 'private'): void {
    this.writeRevision++;
    this._previewMode.set(mode);
    void this.preferences.set('device', PREVIEW_MODE_KEY, mode).catch(() => {});
  }

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const [enabled, sound, previewMode] = await Promise.all([
      this.preferences.get<boolean>('device', ENABLED_KEY),
      this.preferences.get<boolean>('device', SOUND_KEY),
      this.preferences.get<'message' | 'private'>('device', PREVIEW_MODE_KEY),
    ]);
    if (revision !== this.writeRevision) return;
    if (typeof enabled === 'boolean') this._enabled.set(enabled);
    if (typeof sound === 'boolean') this._sound.set(sound);
    if (previewMode === 'message' || previewMode === 'private') this._previewMode.set(previewMode);
  }
}
