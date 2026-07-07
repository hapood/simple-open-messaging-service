import { Component, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * Mobile/tablet top bar: hamburger button (toggleDrawer output) + SOMS title.
 * Menu logic (friend requests / new group / folders / log out) lives in <app-nav-drawer>;
 * global search lives in <app-icon-rail> (desktop) and <app-nav-drawer> (mobile/tablet).
 * This component only triggers the drawer toggle and holds no menu/search state.
 */
@Component({
  selector: 'app-home-header',
  imports: [IconComponent, TranslocoPipe],
  templateUrl: './home-header.component.html',
  styleUrl: './home-header.component.scss',
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType
  readonly toggleDrawer = output<void>()
}
