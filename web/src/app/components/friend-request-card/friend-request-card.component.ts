import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';

export interface FriendRequestCardModel {
  id: string;
  peerId?: number | string;
  name?: string;
  avatar?: string;
  account?: string;
  isForeigner?: boolean;
  domain?: string;
  reqMessage?: string;
  status: number;
  date: number;
  errText: string;
}

@Component({
  selector: 'app-friend-request-card',
  imports: [
    MatButtonModule,
    TranslocoPipe,
    UserAvatarComponent,
    UserIdentityLabelComponent,
  ],
  templateUrl: './friend-request-card.component.html',
  styleUrl: './friend-request-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FriendRequestCardComponent {
  readonly request = input.required<FriendRequestCardModel>();
  readonly direction = input.required<'INCOMING' | 'OUTGOING'>();
  readonly relativeDate = input.required<string>();
  readonly opened = output<void>();
  readonly approved = output<void>();
  readonly revoked = output<void>();
  readonly UserAvatarType = UserAvatarType;

  act(event: Event, action: 'approve' | 'revoke'): void {
    event.stopPropagation();
    if (action === 'approve') this.approved.emit();
    else this.revoked.emit();
  }
}
