import { Component, signal } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { MaterialMenuComponent } from '../material-menu/material-menu.component';
import { MaterialMenuButtonComponent } from '../material-menu-button/material-menu-button.component';

enum MenuItem {
  FRIEND_REQUEST, LOGOUT
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
  MenuItem=MenuItem

  swichMenuShow() {
    this.isShowMenu.set(!this.isShowMenu())
  }
  clickMenu(event: Event, index:MenuItem) {
    event.stopPropagation()
  }
}
