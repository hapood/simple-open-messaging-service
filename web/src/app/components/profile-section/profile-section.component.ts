import { Component, inject } from '@angular/core';
import { ProfileEditorComponent } from '../profile-editor/profile-editor.component';
import { NavStateMachineService } from '../../services/nav-state.service';
import { RouteService } from '../../services/route.service';
import { LogoutService } from '../../services/logout.service';

/**
 * Inline self-profile section opened from the mobile account menu (`topSection === 'profile'`). A thin host around
 * the shared {@link ProfileEditorComponent}: it owns only the side effects the editor emits — back returns to
 * Chats via the nav layering, manage-sessions deep-links to Settings→Devices, logout runs the shared
 * {@link LogoutService} choreography. (No dialog to close here, unlike the EDIT_PROFILE host.) A successful
 * save keeps the user on the page (the `saved` output is intentionally unbound). Desktop reaches profile via
 * the EDIT_PROFILE dialog instead.
 */
@Component({
  selector: 'app-profile-section',
  imports: [ProfileEditorComponent],
  template: `
    <app-profile-editor
      [respectTopSafeArea]="true"
      (back)="goBack()"
      (manageSessions)="onManageSessions()"
      (logout)="onLogout()" />
  `,
  styles: [`
    :host { display: flex; flex-direction: column; min-height: 100%; box-sizing: border-box; }
    app-profile-editor { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  `],
})
export class ProfileSectionComponent {
  private readonly nav = inject(NavStateMachineService)
  private readonly routeService = inject(RouteService)
  private readonly logoutService = inject(LogoutService)

  /** Header back / HW-back → the nav layering peels `topSection` back to 'chats'. */
  goBack() { this.nav.back() }
  onManageSessions() { this.routeService.openSettings('devices') }
  onLogout() { this.logoutService.logout() }
}
