import { Component, input } from '@angular/core';
import { DisplayMsg } from '../../message-thread/model';
import { PureTextCardComponent } from '../pure-text-card/pure-text-card.component';
import { InviteCardComponent } from '../invite-card/invite-card.component';
import { User } from '../../../services/model';

@Component({
  selector: 'app-msg-card',
  standalone: true,
  imports: [PureTextCardComponent, InviteCardComponent],
  templateUrl: './msg-card.component.html',
  styleUrl: './msg-card.component.scss'
})
export class MsgCardComponent {
  data = input<DisplayMsg>()
}
