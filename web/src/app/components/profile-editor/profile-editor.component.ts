import {
  Component,
  signal,
  computed,
  inject,
  effect,
  input,
  output,
  DestroyRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { UserService } from '../../services/user.service';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { AvatarEditorComponent } from '../avatar-editor/avatar-editor.component';
import type {
  PersonalQuotaCategory,
  PersonalQuotaState,
} from '../../services/model';
import { personalQuotaStatus } from './personal-quota-status';

/**
 * Host-agnostic profile-editing body: avatar + display name + read-only handle + bio + account actions
 * (manage sessions / logout). Self-contained — owns its own header (back / title / save) and all EDITING
 * logic (avatar/name/bio). Rendered BOTH as the inline Profile section (mobile account menu) AND inside the
 * EDIT_PROFILE dialog (desktop). Purely presentational for navigation/destructive actions — it emits:
 *  - `back`           — header back button (dialog closes itself; the section returns to Chats).
 *  - `saved`          — a profile save succeeded (dialog closes with `true`; the section stays put and the
 *                       Save button briefly shows a "Saved" confirmation — see {@link justSaved}).
 *  - `manageSessions` — user tapped "Manage sessions" (host deep-links to Settings → Devices; a dialog host
 *                       closes itself first so the Settings surface isn't stacked beneath it).
 *  - `logout`         — user tapped "Log out" (host runs the app-wide logout choreography; a dialog host
 *                       closes itself first so the pane doesn't leak past re-login).
 * The hosts own the side effects (and the shared {@link LogoutService}); this component does no navigation.
 */
@Component({
  selector: 'app-profile-editor',
  imports: [
    FormsModule,
    MatButtonModule,
    UserAvatarComponent,
    IconComponent,
    AvatarEditorComponent,
    TranslocoPipe,
  ],
  templateUrl: './profile-editor.component.html',
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

  readonly back = output<void>();
  readonly saved = output<void>();
  readonly manageSessions = output<void>();
  readonly logout = output<void>();

  readonly sessionProfile = this.userService.sessionProfile;

  readonly name = signal('');
  readonly bio = signal('');
  readonly nameHint = signal('');
  readonly isNameValid = signal(true);
  readonly uploading = signal(false);
  readonly avatarDraft = signal<File | null>(null);
  readonly saving = signal(false);
  /** Brief "Saved" confirmation on the Save button after a successful save (~1.5s). */
  readonly justSaved = signal(false);
  readonly quota = signal<PersonalQuotaState | null>(null);
  readonly quotaLoading = signal(true);
  readonly quotaExpanded = signal(false);
  readonly quotaCategories: PersonalQuotaCategory[] = [
    'messages',
    'images',
    'largeFiles',
    'requests',
  ];
  readonly quotaStatus = computed(() => {
    const state = this.quota();
    return state ? personalQuotaStatus(state) : 'healthy';
  });
  private savedTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    const p = this.sessionProfile();
    this.name.set(p?.name ?? '');
    this.bio.set(p?.bio ?? '');
    let renderedName = p?.name ?? '';
    let renderedBio = p?.bio ?? '';

    // Both hosts create this component only when the self-profile surface opens. Send an ACK-only revision
    // probe; when stale the server emits PROFILE_REV_UPDATED and the existing SSE path pulls the full
    // profile through sessionProfile → ProfileRepository → IndexedDB/avatar notification.
    if (p) this.userService.syncSelfProfile(p.profileRev);
    this.userService.getMyQuota().subscribe({
      next: (res) => {
        this.quota.set(res.data ?? null);
        this.quotaLoading.set(false);
      },
      error: () => this.quotaLoading.set(false),
    });

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

    // Name validation: non-empty (trimmed) and ≤30. Mirrors register.component.ts's effect-based validation.
    effect(() => {
      const n = this.name().trim();
      if (n.length === 0) {
        this.isNameValid.set(false);
        this.nameHint.set(this.transloco.translate('profile.nameEmpty'));
      } else if (n.length > 30) {
        this.isNameValid.set(false);
        this.nameHint.set(this.transloco.translate('profile.nameTooLong'));
      } else {
        this.isNameValid.set(true);
        this.nameHint.set('');
      }
    });

    // Clear the "Saved" flash timer if the editor is torn down mid-flash (dialog close, tab switch).
    this.destroyRef.onDestroy(() => clearTimeout(this.savedTimer));
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
      !this.uploading() &&
      (nameChanged || bioChanged)
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
    this.uploadAvatarFile(file);
  }

  private uploadAvatarFile(file: File) {
    this.uploading.set(true);
    this.userService.updateAvatar(file).subscribe({
      next: () => {
        this.uploading.set(false);
        // avatar persisted → re-read sessionProfile; rail/tab/preview refresh accordingly.
        this.userService.updateSessionProfile();
      },
      error: () => {
        this.uploading.set(false);
      },
    });
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.userService
      .updateProfile({ name: this.name().trim(), bio: this.bio() })
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          if (res.code === 0) {
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

  /** Flash the "Saved" confirmation on the Save button for ~1.5s (re-entrant — a rapid second save resets it). */
  private flashSaved() {
    this.justSaved.set(true);
    clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => this.justSaved.set(false), 1500);
  }

  goBack() {
    this.back.emit();
  }

  /** "Manage sessions" → host deep-links to Settings → Devices (closing itself first if it's a dialog). */
  onManageSessions() {
    this.manageSessions.emit();
  }

  /** "Log out" → host runs the app-wide logout choreography (closing itself first if it's a dialog). */
  onLogout() {
    this.logout.emit();
  }

  quotaPercent(category: PersonalQuotaCategory): number {
    const item = this.quota()?.usage[category];
    if (!item || item.limit === 0) return 0;
    return Math.min(100, Math.round((item.count / item.limit) * 100));
  }

  formatBytes(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }

  formatResetAt(value: string): string {
    return new Intl.DateTimeFormat(this.transloco.getActiveLang(), {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
