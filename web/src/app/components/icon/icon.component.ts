import { Component, input } from '@angular/core';
import { AppIconType } from './model'

export { AppIconType } from './model';
@Component({
    selector: 'app-icon',
    imports: [],
    templateUrl: './icon.component.html',
    styleUrl: './icon.component.scss'
})
export class IconComponent {
  readonly type = input<AppIconType>()

  readonly style = input<{ width: string, height: string }>()
  readonly AppIcon = AppIconType
}
