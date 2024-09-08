import { Component, input } from '@angular/core';
import { IconComponent } from "../icon/icon.component";
import { AppIconType } from '../icon/model';

@Component({
  selector: 'app-message-header',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './message-header.component.html',
  styleUrl: './message-header.component.scss'
})
export class MessageHeaderComponent {
  readonly AppIconType = AppIconType
  readonly name = input('')
}
