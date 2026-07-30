import { Component, inject } from '@angular/core';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { ProfileEditorComponent } from '../profile-editor/profile-editor.component';
import { RouteService } from '../../services/route.service';
import { LogoutService } from '../../services/logout.service';

/**
 * EDIT_PROFILE dialog host: a thin wrapper that pins the dialog height ([appFitDialog]) around the shared
 * {@link ProfileEditorComponent} body, wiring its outputs to the dialog + navigation lifecycle. The editor is
 * purely presentational for navigation; this host owns the side effects: back / navigate-away → `closeDlg()`,
 * save → `closeDlg(true)`, manage-sessions → close + deep-link Settings→Devices, logout → close + the shared
 * {@link LogoutService} choreography. Used on every layout; compact renders it as a full-screen page.
 */
@Component({
  selector: 'app-edit-profile',
  imports: [FitDialogDirective, ProfileEditorComponent],
  templateUrl: './edit-profile.component.html',
  styleUrl: './edit-profile.component.scss',
})
export class EditProfileComponent {
  private readonly routeService = inject(RouteService)
  private readonly logoutService = inject(LogoutService)

  /** Pins the dialog to its natural height (clamped to 80vh) on desktop so the body scrolls internally and
   *  the header stays fixed — matches the other popup dialogs. */
  readonly fitOpts = { minHeight: 380 } as const

  goBack() { this.routeService.closeDlg() }
  /** Save succeeded → close with `true` (PopupResult[EDIT_PROFILE]). */
  onSaved() { this.routeService.closeDlg(true) }
  /** Close first so the Settings surface isn't stacked beneath this dialog, then deep-link to Devices. */
  onManageSessions() {
    this.routeService.closeDlg()
    this.routeService.openSettings('devices')
  }
  /** Close first so this pane doesn't leak past re-login, then run the shared logout choreography. */
  onLogout() {
    this.routeService.closeDlg()
    this.logoutService.logout()
  }
}
