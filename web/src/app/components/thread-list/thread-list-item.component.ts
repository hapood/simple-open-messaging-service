import {
  ChangeDetectionStrategy,
  Component,
  afterRenderEffect,
  ElementRef,
  viewChild,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConversationItem } from '../../services/model';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import {
  conversationAvatarType,
  conversationAvatarAccount,
  conversationAvatarNamespaceId,
} from '../user-avatar/conversation-avatar.util';
import { conversationAvatarProfile } from '../../services/avatar-profile-ref';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { UserIdentityLabelComponent } from '../user-identity-label/user-identity-label.component';
import { SendingTaskIndicatorComponent } from '../message-header/sending-task-indicator.component';
import { FlipCountComponent } from '../message-header/flip-count.component';

/** A keyed, input-only row. Domain state and list ordering belong to its parent. */
@Component({
  selector: 'app-thread-list-item',
  imports: [
    TranslocoPipe,
    DemandAvatarComponent,
    IconComponent,
    UserIdentityLabelComponent,
    SendingTaskIndicatorComponent,
    FlipCountComponent,
  ],
  templateUrl: './thread-list-item.component.html',
  styleUrl: './thread-list-item.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThreadListItemComponent {
  readonly thread = input.required<ConversationItem>();
  readonly active = input(false);
  readonly unreadCount = input(0);
  readonly name = input('');
  readonly preview = input('');
  readonly time = input('');
  readonly label = input('');
  readonly joinRequests = input(false);
  readonly messageCount = input(0);
  readonly uploadCount = input(0);
  readonly failedCount = input(0);
  readonly unavailable = input(false);
  readonly select = output<void>();
  readonly navigate = output<KeyboardEvent>();
  readonly pinExited = output<void>();
  readonly pinVisible = signal(false);
  private readonly pin = viewChild.required<ElementRef<HTMLElement>>('pin');
  readonly AppIconType = AppIconType;
  readonly avatarType = conversationAvatarType;
  readonly avatarAccount = conversationAvatarAccount;
  readonly avatarNamespaceId = conversationAvatarNamespaceId;
  readonly avatarProfile = conversationAvatarProfile;

  constructor() {
    // Start entry only after Angular has placed the keyed row at its new position.
    // CSS transitions retarget from the current rendered opacity/transform.
    afterRenderEffect(() => {
      const pinned = this.thread().pinned;
      // Commit the initial hidden style before changing the target. This is local
      // badge geometry only, never a row displacement or a list layout snapshot.
      if (pinned) void getComputedStyle(this.pin().nativeElement).opacity;
      this.pinVisible.set(pinned);
    });
  }

  onPinTransitionEnd(event: TransitionEvent): void {
    if (
      event.target === event.currentTarget &&
      event.propertyName === 'opacity' &&
      !this.pinVisible()
    )
      this.pinExited.emit();
  }
}
