import { Component, inject, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { SearchService } from '../../services/search.service';

/**
 * Top bar: hamburger button (toggleDrawer output) + SOMS title + search button.
 * Menu logic (friend requests / new group / folders / log out) moved to <app-nav-drawer>;
 * this component only triggers the drawer toggle + global-search open and holds no menu state.
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
  readonly search = inject(SearchService)
}
