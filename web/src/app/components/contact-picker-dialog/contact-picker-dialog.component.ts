import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConversationListService } from '../../services/conversation-list.service';
import { displayThreadName, type ConversationItem } from '../../services/model';
import { RouteService } from '../../services/route.service';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import {
  conversationAvatarAccount,
  conversationAvatarNamespaceId,
  conversationAvatarType,
} from '../user-avatar/conversation-avatar.util';
import { conversationAvatarProfile } from '../../services/avatar-profile-ref';

@Component({
  selector: 'app-contact-picker-dialog',
  standalone: true,
  imports: [DemandAvatarComponent, TranslocoPipe],
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
  readonly avatarNamespaceId = conversationAvatarNamespaceId;
  readonly avatarProfile = conversationAvatarProfile;

  /** Selection is immediate: the preview uses already-materialized thread display
   *  fields, and the server freezes the authoritative card (address, root key,
   *  avatar) from the pinned target when the message is sent. Identity
   *  verification belongs to the add-friend flow, not this picker. */
  choose(item: ConversationItem): void {
    const target = item.type === 'GROUP' ? item.group : item.peerUser;
    this.route.closeDlg({
      target: {
        account: target.account,
        namespaceId: target.namespaceId,
        profileRev: item.profileRev,
      },
      account: target.account,
      name: this.displayName(item),
      bio:
        (item.type === 'GROUP' ? item.group.description : item.peerUser.bio) ??
        '',
    });
  }
}
