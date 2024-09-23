import { Component, signal } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialMenuComponent } from '../material-menu/material-menu.component';
import { MaterialMenuButtonComponent } from '../material-menu-button/material-menu-button.component';
import { RouteService, PopupType } from '../../services/route.service';

enum MenuItem {
  FRIEND_REQUESTS, LOGOUT, NEW_GROUP
}
@Component({
  selector: 'app-home-header',
  standalone: true,
  imports: [IconComponent, MaterialMenuComponent, MaterialMenuButtonComponent],
  templateUrl: './home-header.component.html',
  styleUrl: './home-header.component.scss'
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType
  isShowMenu = signal(false)
  MenuItem = MenuItem
  constructor(private routeService: RouteService) { }
  swichMenuShow() {
    this.isShowMenu.set(!this.isShowMenu())
  }
  clickMenu(event: Event, menuItem: MenuItem) {
    this.isShowMenu.set(false)
    event.stopPropagation()
    if (menuItem === MenuItem.FRIEND_REQUESTS) {
      this.routeService.popupDlg({
        caller: "HomeHeaderMenu",
        popupType: PopupType.FRIEND_REQUESTS
      })
    } else if (menuItem === MenuItem.NEW_GROUP) {
      this.routeService.popupDlg({
        caller: "HomeHeaderMenu",
        popupType: PopupType.NEW_GROUP
      })
    }
  }
}
