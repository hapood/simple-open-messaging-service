import { Component, input } from '@angular/core';
import { IconComponent, AppIconType } from "../icon/icon.component";

@Component({
  selector: 'app-home-header',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './home-header.component.html',
  styleUrl: './home-header.component.scss'
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType
}
