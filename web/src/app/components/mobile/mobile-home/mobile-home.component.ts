import { Component, viewChild, inject, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ConversationItem } from '../../../services/model'
import { HomeHeaderComponent } from '../../home-header/home-header.component';
import { ThreadListComponent } from '../../thread-list/thread-list.component';
import { NavDrawerComponent } from '../../nav-drawer/nav-drawer.component';
import { RootPopupComponent } from '../../root-popup/root-popup.component';
import { RouteService, PopupType, DlgRef } from '../../../services/route.service';
import { ConversationListService } from '../../../services/conversation-list.service';
@Component({
    selector: 'app-mobile-home',
    imports: [HomeHeaderComponent, ThreadListComponent, NavDrawerComponent, RootPopupComponent],
    templateUrl: './mobile-home.component.html',
    styleUrl: './mobile-home.component.scss'
})
export class MobileHomeComponent {
  readonly threadListCmp = viewChild(ThreadListComponent)
  private readonly routeService = inject(RouteService)
  private readonly convList = inject(ConversationListService)

  /**
   * The chat popup currently open (its DlgRef + threadId), or undefined when none. Kept as a plain field:
   * the removal-watcher effect below re-runs on every convList.items() change and re-reads it, so it needs
   * no signal reactivity of its own. The DlgRef lets us close this specific popup (and any profile/info
   * popup stacked above it) when an external event invalidates the thread.
   */
  private chatDlg?: { ref: DlgRef; threadId: number }

  constructor() {
    // Honor open-conversation intents from elsewhere (e.g. the invite card's "Open group" after
    // joining) by routing them through the same selection path as clicking the list.
    this.convList.openRequest$.pipe(takeUntilDestroyed()).subscribe((item) => this.onThreadSelect(item))

    // If the open chat's thread is removed (unfriend / self-leave / kicked — all funnel through
    // ConversationListService.removeThread), close the chat popup AND anything stacked above it (a
    // profile/info popup is scoped to that chat and must close with it). This covers the cases the
    // profile's own closeDlg can't: an external SSE removal, or a chat popup buried under a child. The
    // desktop/tablet shells clear their *inline* selection on the same condition; mobile renders the chat
    // as a popup, so here we close the popup by ref instead.
    effect(() => {
      const chat = this.chatDlg
      if (!chat) return
      if (this.convList.items().some((t) => t.threadId === chat.threadId)) return // still present
      this.chatDlg = undefined
      this.routeService.closeDialogAndAbove(chat.ref)
    })
  }

  // forwarded to <app-nav-drawer> as the NewGroup dialog's onResult, so creating
  // a group refreshes the list
  refreshThreadList = () => {
    this.threadListCmp()?.genThreadList()
  }

  onThreadSelect(userMsgTrd: ConversationItem) {
    // Mark the thread open (mark-read + clear badge); clear it again when the chat popup closes,
    // so later incoming messages re-arm the badge.
    this.convList.open(userMsgTrd.threadId)
    const ref = this.routeService.popupDlg(
      PopupType.MSG_THREAD,
      { threadId: userMsgTrd.threadId, userMsgTrd },
      () => {
        // popup closed (back / closeDlg / scoped close) — drop tracking so the effect won't re-fire
        this.chatDlg = undefined
        this.convList.close()
      },
    )
    this.chatDlg = { ref, threadId: userMsgTrd.threadId }
  }
}
