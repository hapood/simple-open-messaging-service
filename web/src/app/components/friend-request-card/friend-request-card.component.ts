import {
  RequestProjectionStatus,
  type RequestProjectionStatusValue,
} from '../../../../../shared/request-projection-status';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';
import type { ProfileDemand } from '../../../../../shared/profile-demand';
import { homeProfileDemand } from '../../services/profile-demand';
import { NamespaceDomainPipe } from '../../pipes/namespace-domain.pipe';

export interface FriendRequestCardModel {
  id: string;
  peerId?: number | string;
  account: string;
  namespaceId: number;
  reqMessage?: string;
  status: RequestProjectionStatusValue;
  date: number;
  errText: string;
  kind?: 'FRIEND' | 'GROUP';
  profileRev?: number;
}

@Component({
  selector: 'app-friend-request-card',
  imports: [
    AsyncPipe,
    MatButtonModule,
    NamespaceDomainPipe,
    TranslocoPipe,
    UserAvatarComponent,
    UserIdentityLabelComponent,
  ],
  templateUrl: './friend-request-card.component.html',
  styleUrl: './friend-request-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FriendRequestCardComponent {
  private readonly transloco = inject(TranslocoService);
  readonly RequestProjectionStatus = RequestProjectionStatus;
  readonly requestItem = input.required<FriendRequestCardModel>();
  readonly direction = input.required<'INCOMING' | 'OUTGOING'>();
  readonly relativeDate = input.required<string>();
  readonly actionPending = input(false);
  readonly opened = output<void>();
  readonly approved = output<void>();
  readonly revoked = output<void>();
  readonly rejected = output<void>();
  readonly UserAvatarType = UserAvatarType;

  profileEvidence(): ProfileDemand | undefined {
    const request = this.requestItem();
    return request.account && request.profileRev
      ? homeProfileDemand(
          request.account,
          request.namespaceId,
          request.profileRev,
        )
      : undefined;
  }

  act(event: Event, action: 'approve' | 'revoke' | 'reject'): void {
    event.stopPropagation();
    if (this.actionPending()) return;
    if (action === 'approve') this.approved.emit();
    else if (action === 'revoke') this.revoked.emit();
    else this.rejected.emit();
  }
}
