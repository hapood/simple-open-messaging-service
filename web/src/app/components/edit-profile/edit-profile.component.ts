import { Component, signal, computed, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService, RoutePage, PopupType } from '../../services/route.service';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { UserService } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';

/**
 * Edit-profile dialog (WhatsApp-minimal): avatar + display name + bio; the login handle is read-only.
 * Avatar goes through the existing update-avatar (sharp multi-size); name/bio go through update-profile;
 * either success re-reads sessionProfile (rail/drawer/preview all bind the signal and refresh automatically).
 */
@Component({
  selector: 'app-edit-profile',
  imports: [FormsModule, MatButtonModule, UserAvatarComponent, IconComponent, FitDialogDirective, TranslocoPipe],
  templateUrl: './edit-profile.component.html',
  styleUrl: './edit-profile.component.scss',
})
export class EditProfileComponent {
  private readonly routeService = inject(RouteService)
  private readonly userService = inject(UserService)
  private readonly authService = inject(AuthService)
  private readonly wsService = inject(WebsocketService)
  private readonly transloco = inject(TranslocoService)

  readonly UserAvatarType = UserAvatarType
  readonly AppIconType = AppIconType
  /** Pins the dialog to its natural height (clamped to 80vh) on desktop so the body scrolls
   *  internally and the header stays fixed — matches the other popup dialogs. */
  readonly fitOpts = { minHeight: 380 } as const

  readonly sessionProfile = this.userService.sessionProfile

  readonly name = signal('')
  readonly bio = signal('')
  readonly nameHint = signal('')
  readonly isNameValid = signal(true)
  readonly uploading = signal(false)
  readonly saving = signal(false)

  constructor() {
    const p = this.sessionProfile()
    this.name.set(p?.name ?? '')
    this.bio.set(p?.bio ?? '')

    // Name validation: non-empty (trimmed) and ≤30. Mirrors register.component.ts's effect-based validation.
    effect(() => {
      const n = this.name().trim()
      if (n.length === 0) {
        this.isNameValid.set(false)
        this.nameHint.set(this.transloco.translate('profile.nameEmpty'))
      } else if (n.length > 30) {
        this.isNameValid.set(false)
        this.nameHint.set(this.transloco.translate('profile.nameTooLong'))
      } else {
        this.isNameValid.set(true)
        this.nameHint.set('')
      }
    })
  }

  /** Saveable only when the nickname is valid, no request is in flight, and at least one field changed vs the current session. */
  readonly canSave = computed(() => {
    const p = this.sessionProfile()
    if (!p) return false
    const nameChanged = this.name().trim() !== (p.name ?? '')
    const bioChanged = this.bio() !== (p.bio ?? '')
    return this.isNameValid() && !this.saving() && !this.uploading() && (nameChanged || bioChanged)
  })

  onAvatarPicked(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // clear so the same file can be picked again
    if (!file) return
    // Hand the raw file to the cropper; upload only the cropped square it returns.
    // Cancel/back yields no result, so nothing uploads.
    this.routeService.popupDlg(PopupType.AVATAR_EDITOR, { file }, (res) => {
      if (res?.file) this.uploadAvatarFile(res.file)
    })
  }

  private uploadAvatarFile(file: File) {
    this.uploading.set(true)
    this.userService.updateAvatar(file).subscribe({
      next: () => {
        this.uploading.set(false)
        // avatar persisted → re-read sessionProfile; rail/drawer/preview refresh accordingly.
        this.userService.updateSessionProfile()
      },
      error: () => {
        this.uploading.set(false)
      },
    })
  }

  save() {
    if (!this.canSave()) return
    this.saving.set(true)
    this.userService.updateProfile({ name: this.name().trim(), bio: this.bio() }).subscribe({
      next: (res) => {
        this.saving.set(false)
        if (res.code === 0) {
          this.userService.updateSessionProfile()
          this.routeService.closeDlg(true)
        }
      },
      error: () => {
        this.saving.set(false)
      },
    })
  }

  goBack() {
    this.routeService.closeDlg()
  }

  openSessions() {
    this.routeService.popupDlg(PopupType.SESSIONS)
  }

  /**
   * Logout from inside the dialog. Logout invalidates the whole session, so first pop this dialog
   * (reconciling its sentinel history entry — redirect() alone wouldn't touch the dialog stack and the
   * root-level dlgList would otherwise leak this entry past re-login), then mirror the nav-drawer flow:
   * disconnect WS, clear credentials, go to login. logout() calls clearToken() internally, so the redirect
   * happens whether or not backend revocation succeeds.
   */
  logout() {
    this.routeService.closeDlg()
    this.wsService.disconnect()
    this.authService.logout().subscribe({
      complete: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
      error: () => this.routeService.redirect(RoutePage.AUTH_LOGIN),
    })
  }
}
