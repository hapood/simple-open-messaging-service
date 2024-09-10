import { Component, signal } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialMenuComponent } from '../material-menu/material-menu.component';
import { MaterialMenuButtonComponent } from '../material-menu-button/material-menu-button.component';
import { PopupService, PopupType } from '../../services/popup.service';

enum MenuItem {
  FRIEND_REQUESTS, LOGOUT
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
  constructor(private popupService: PopupService) { }
  swichMenuShow() {
    this.isShowMenu.set(!this.isShowMenu())
  }
  clickMenu(event: Event, menuItem: MenuItem) {
    event.stopPropagation()
    if (menuItem === MenuItem.FRIEND_REQUESTS) {
      this.popupService.subject.next({
        caller: "HomeHeaderMenu",
        isShow: true, popupType: PopupType.FRIEND_REQUESTS
      })
    }
  }
}
