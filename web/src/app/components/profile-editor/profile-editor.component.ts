import {
  Component,
  signal,
  computed,
  inject,
  effect,
  input,
  output,
  DestroyRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { UserService } from '../../services/user.service';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { AvatarEditorComponent } from '../avatar-editor/avatar-editor.component';
import { PageHeaderComponent } from '../page-header/page-header.component';
import {
  limitUnicodeCodePoints,
  unicodeCodePointLength,
} from '../../lib/unicode-text';

/**
 * Host-agnostic profile-editing body: avatar + identity + editable display name/bio + logout. Self-contained —
 * owns its own header (back / title / save) and all editing
 * logic (avatar/name/bio). Rendered BOTH as the inline Profile section (mobile account menu) AND inside the
 * EDIT_PROFILE dialog (desktop). Purely presentational for navigation/destructive actions — it emits:
 *  - `back`           — header back button (dialog closes itself; the section returns to Chats).
 *  - `saved`          — a profile save succeeded (dialog closes with `true`; the section stays put and the
 *                       Save button briefly shows a "Saved" confirmation — see {@link justSaved}).
 *  - `logout`         — user tapped "Log out" (host runs the app-wide logout choreography; a dialog host
 *                       closes itself first so the pane doesn't leak past re-login).
 * The hosts own the side effects (and the shared {@link LogoutService}); this component does no navigation.
 */
@Component({
  selector: 'app-profile-editor',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    UserAvatarComponent,
    IconComponent,
    AvatarEditorComponent,
    PageHeaderComponent,
    TranslocoPipe,
  ],
  templateUrl: './profile-editor.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './profile-editor.component.scss',
})
export class ProfileEditorComponent {
  private readonly userService = inject(UserService);
  private readonly transloco = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);

  readonly UserAvatarType = UserAvatarType;
  readonly AppIconType = AppIconType;
  /** Inline compact pages sit beneath the native status bar; centered dialogs leave this disabled. */
  readonly respectTopSafeArea = input(false);
  readonly NAME_MAX = 31;
  readonly BIO_MAX = 120;

  readonly back = output<void>();
  readonly saved = output<void>();
  readonly logout = output<void>();

  readonly sessionProfile = this.userService.sessionProfile;

  readonly name = signal('');
  readonly bio = signal('');
  readonly nameHint = signal('');
  readonly isNameValid = signal(true);
  readonly avatarDraft = signal<File | null>(null);
  readonly pendingAvatar = signal<File | null>(null);
  /** Local crop preview shown until the refreshed session profile takes over. */
  readonly avatarPreviewUrl = signal('');
  readonly saving = signal(false);
  /** Brief "Saved" confirmation on the Save button after a successful save (~1.5s). */
  readonly justSaved = signal(false);
  private savedTimer?: ReturnType<typeof setTimeout>;

  nameLength(): number {
    return unicodeCodePointLength(this.name());
  }

  bioLength(): number {
    return unicodeCodePointLength(this.bio());
  }

  onNameInput(value: string): void {
    this.name.set(limitUnicodeCodePoints(value, this.NAME_MAX));
  }

  onBioInput(value: string): void {
    this.bio.set(limitUnicodeCodePoints(value, this.BIO_MAX));
  }

  constructor() {
    const p = this.sessionProfile();
    this.name.set(p?.name ?? '');
    this.bio.set(p?.bio ?? '');
    let renderedName = p?.name ?? '';
    let renderedBio = p?.bio ?? '';

    // Apply the refreshed profile to fields that are still pristine. If the user starts typing before the
    // request returns, preserve that draft instead of replacing it with the server response.
    effect(() => {
      const fresh = this.sessionProfile();
      if (!fresh) return;
      const pristine =
        this.name() === renderedName && this.bio() === renderedBio;
      renderedName = fresh.name ?? '';
      renderedBio = fresh.bio ?? '';
      if (pristine) {
        this.name.set(renderedName);
        this.bio.set(renderedBio);
      }
    });

    // Name validation: non-empty (trimmed) and <=31 Unicode code points.
    effect(() => {
      const n = this.name().trim();
      if (n.length === 0) {
        this.isNameValid.set(false);
        this.nameHint.set(this.transloco.translate('profile.nameEmpty'));
      } else if (unicodeCodePointLength(n) > this.NAME_MAX) {
        this.isNameValid.set(false);
        this.nameHint.set(this.transloco.translate('profile.nameTooLong'));
      } else {
        this.isNameValid.set(true);
        this.nameHint.set('');
      }
    });

    // Clear the "Saved" flash timer if the editor is torn down mid-flash (dialog close, tab switch).
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.savedTimer);
      this.clearAvatarPreview();
    });
  }

  /** Saveable only when the nickname is valid, no request is in flight, and at least one field changed. */
  readonly canSave = computed(() => {
    const p = this.sessionProfile();
    if (!p) return false;
    const nameChanged = this.name().trim() !== (p.name ?? '');
    const bioChanged = this.bio() !== (p.bio ?? '');
    return (
      this.isNameValid() &&
      !this.saving() &&
      (nameChanged || bioChanged || this.pendingAvatar() !== null)
    );
  });

  onAvatarPicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // clear so the same file can be picked again
    if (!file) return;
    // Keep avatar adjustment in this profile surface so the form is not covered by a second dialog.
    this.avatarDraft.set(file);
  }

  cancelAvatarEdit() {
    this.avatarDraft.set(null);
  }

  finishAvatarEdit(file: File) {
    this.avatarDraft.set(null);
    this.pendingAvatar.set(file);
    this.clearAvatarPreview();
    this.avatarPreviewUrl.set(URL.createObjectURL(file));
  }

  async save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    let avatarBase64: string | undefined;
    const avatar = this.pendingAvatar();
    if (avatar) {
      try {
        avatarBase64 = await this.fileBase64(avatar);
      } catch {
        this.saving.set(false);
        return;
      }
    }
    this.userService
      .updateProfile({
        name: this.name().trim(),
        bio: this.bio(),
        ...(avatarBase64 === undefined ? {} : { avatarBase64 }),
      })
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          if (res.code === 0) {
            this.pendingAvatar.set(null);
            this.userService.updateSessionProfile();
            this.saved.emit();
            this.flashSaved();
          }
        },
        error: () => {
          this.saving.set(false);
        },
      });
  }

  private fileBase64(file: File): Promise<string> {
    return file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    });
  }

  private clearAvatarPreview() {
    const url = this.avatarPreviewUrl();
    if (!url) return;
    URL.revokeObjectURL(url);
    this.avatarPreviewUrl.set('');
  }

  /** Flash the "Saved" confirmation on the Save button for ~1.5s (re-entrant — a rapid second save resets it). */
  private flashSaved() {
    this.justSaved.set(true);
    clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => this.justSaved.set(false), 1500);
  }

  goBack() {
    this.back.emit();
  }

  /** "Log out" → host runs the app-wide logout choreography (closing itself first if it's a dialog). */
  onLogout() {
    this.logout.emit();
  }
}
