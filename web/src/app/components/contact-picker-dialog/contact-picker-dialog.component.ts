import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConversationListService } from '../../services/conversation-list.service';
import { displayThreadName, type ConversationItem } from '../../services/model';
import { RouteService } from '../../services/route.service';
import { UserAvatarComponent } from '../user-avatar/user-avatar.component';
import {
  conversationAvatarAccount,
  conversationAvatarDomain,
  conversationAvatarEvidence,
  conversationAvatarSrc,
  conversationAvatarType,
} from '../user-avatar/conversation-avatar.util';

@Component({
  selector: 'app-contact-picker-dialog',
  standalone: true,
  imports: [UserAvatarComponent, TranslocoPipe],
  templateUrl: './contact-picker-dialog.component.html',
  styleUrl: './contact-picker-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactPickerDialogComponent {
  private readonly conversations = inject(ConversationListService);
  private readonly route = inject(RouteService);
  readonly items = this.conversations.items;
  readonly displayName = displayThreadName;
  readonly avatarType = conversationAvatarType;
  readonly avatarAccount = conversationAvatarAccount;
  readonly avatarDomain = conversationAvatarDomain;
  readonly avatarEvidence = conversationAvatarEvidence;
  readonly avatarSrc = conversationAvatarSrc;

  choose(item: ConversationItem): void {
    const target = item.type === 'GROUP' ? item.group : item.peerUser;
    this.route.closeDlg({
      target: {
        account: target.account,
        domain: target.domain,
        namespaceId: target.namespaceId,
        profileRev: target.profileRev,
      },
      account:
        item.type === 'GROUP' ? item.group.account : item.peerUser.account,
      domain: item.type === 'GROUP' ? item.group.domain : item.peerUser.domain,
      name: this.displayName(item),
      avatar: this.avatarSrc(item),
      bio:
        (item.type === 'GROUP' ? item.group.description : item.peerUser.bio) ??
        '',
    });
  }
}
