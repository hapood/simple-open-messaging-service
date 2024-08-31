import { Component, computed, input } from '@angular/core';
import { AppIconType } from './modal'

@Component({
  selector: 'app-icon',
  standalone: true,
  imports: [],
  templateUrl: './icon.component.html',
  styleUrl: './icon.component.scss'
})
export class IconComponent {
  readonly type = input<AppIconType>()

  readonly style = input<{ width: string, height: string }>()
  readonly AppIcon = AppIconType
}
