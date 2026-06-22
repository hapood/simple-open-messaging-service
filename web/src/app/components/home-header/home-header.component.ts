import { Component, input, signal } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialMenuComponent } from '../material-menu/material-menu.component';
import { MaterialMenuButtonComponent } from '../material-menu-button/material-menu-button.component';
import { RouteService, PopupType } from '../../services/route.service';

enum MenuItem {
  FRIEND_REQUESTS, LOGOUT, NEW_GROUP
}
@Component({
    selector: 'app-home-header',
    imports: [IconComponent, MaterialMenuComponent, MaterialMenuButtonComponent],
    templateUrl: './home-header.component.html',
    styleUrl: './home-header.component.scss'
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType
  isShowMenu = signal(false)
  MenuItem = MenuItem
  // refresh callback supplied by Home, forwarded as the NewGroup dialog's onResult
  onThreadListChanged = input<(() => void) | undefined>(undefined)
  constructor(private routeService: RouteService) { }
  swichMenuShow() {
    this.isShowMenu.set(!this.isShowMenu())
  }
  clickMenu(event: Event, menuItem: MenuItem) {
    this.isShowMenu.set(false)
    event.stopPropagation()
    if (menuItem === MenuItem.FRIEND_REQUESTS) {
      this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
    } else if (menuItem === MenuItem.NEW_GROUP) {
      this.routeService.popupDlg(PopupType.NEW_GROUP, undefined, (result) => {
        // only refresh when a group was actually created, not on cancel/back
        if (result) this.onThreadListChanged()?.()
      })
    }
  }
}
