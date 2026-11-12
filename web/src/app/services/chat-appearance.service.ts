import { effect, inject, Injectable, signal } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

const SHOW_SELF_AVATAR_KEY = 'soms.chat.showSelfAvatar';

/**
 * Device-local chat appearance preferences. Message rows are mounted outside the normal Angular view tree,
 * so preferences are also reflected onto `<html>` and existing rows can update through CSS without rebuilding.
 */
@Injectable({ providedIn: 'root' })
export class ChatAppearanceService {
  private readonly preferences = inject(PreferenceStore);
  private writeRevision = 0;
  // Default ON: most users expect to see their own avatar alongside their messages. Only a stored preference
  // (a user who explicitly turned it off) overrides this — new users and cleared-storage starts show self avatars.
  private readonly _showSelfAvatar = signal(true);

  readonly showSelfAvatar = this._showSelfAvatar.asReadonly();

  constructor() {
    this.applySelfAvatar(this._showSelfAvatar());
    effect(() => this.applySelfAvatar(this._showSelfAvatar()));
    void this.restore();
  }

  setShowSelfAvatar(show: boolean): void {
    this.writeRevision++;
    this._showSelfAvatar.set(show);
    void this.preferences.set('device', SHOW_SELF_AVATAR_KEY, show).catch(() => {});
  }

  private applySelfAvatar(show: boolean): void {
    document.documentElement.setAttribute('data-show-self-avatar', String(show));
  }

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const show = await this.preferences.get<boolean>('device', SHOW_SELF_AVATAR_KEY);
    if (revision !== this.writeRevision) return;
    if (typeof show === 'boolean') this._showSelfAvatar.set(show);
  }
}
