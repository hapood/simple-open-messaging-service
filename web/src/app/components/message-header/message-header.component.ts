import { Component, input } from '@angular/core';
import { IconComponent } from "../icon/icon.component";
import { AppIconType } from '../icon/model';
import { RouteService } from '../../services/route.service';
@Component({
  selector: 'app-message-header',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './message-header.component.html',
  styleUrl: './message-header.component.scss'
})
export class MessageHeaderComponent {
  readonly AppIconType = AppIconType
  readonly title = input('')
  constructor(private routeService: RouteService) {

  }
  goBack() {
    this.routeService.go(-1)
  }
}
