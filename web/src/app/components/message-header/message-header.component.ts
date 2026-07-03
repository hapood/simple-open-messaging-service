import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent, AppIconType } from "../icon/icon.component";
import { ConversationItem } from '../../services/model';
import { LayoutService } from '../../services/layout.service';

@Component({
    selector: 'app-message-header',
    imports: [IconComponent],
    templateUrl: './message-header.component.html',
    styleUrl: './message-header.component.scss'
})
export class MessageHeaderComponent {
  readonly AppIconType = AppIconType
  readonly userMsgTrd = input<ConversationItem>()
  readonly title = computed(() => {
    const userMsgTrd = this.userMsgTrd()
    if (userMsgTrd !== undefined) {
      if (userMsgTrd.type === 'P2P') {
        return userMsgTrd.peerUser.uniqName
      } else if (userMsgTrd.type === 'GROUP') {
        return userMsgTrd.group.name
      }
    }
    return ''
  })
  // desktop renders the chat inline (no overlay to leave), so the back arrow is mobile-only.
  protected readonly isDesktop = inject(LayoutService).isDesktop
  private readonly router = inject(Router)

  /** Mobile: the chat is a routed overlay — back returns to the conversation list. */
  goBack() {
    this.router.navigate(['/'])
  }

  /**
   * Open (or toggle) the peer-profile / group-info panel in the `aside` auxiliary outlet. The segment
   * picked from the thread type replaces the old desktop InfoPanelService toggle and the mobile popups —
   * one mechanism for every layout. Toggling the SAME panel closed reuses the URL state.
   */
  showThreadInfo() {
    const trd = this.userMsgTrd()
    if (!trd || trd.threadId === undefined) return
    const seg = trd.type === 'GROUP' ? 'group-info' : 'profile'
    const openSeg = this.router.url.match(/\(aside:([a-z-]+)\)/)?.[1]
    const outlets = openSeg === seg ? { aside: null } : { aside: seg }
    this.router.navigate(['chat', trd.threadId, { outlets }])
  }
}
