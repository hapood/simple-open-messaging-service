import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subject, Subscription, filter } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { WebsocketService } from './websocket.service';
import { ConversationListService } from './conversation-list.service';
import { UserService } from './user.service';

/**
 * Shared payload shape of every GROUP_* SSE frame. The backend's `fanoutGroup` always carries
 * `groupId` + `threadId`; the remaining fields depend on the event (see {@link GroupSseEvent} in
 * sse.service.ts).
 */
interface GroupEventPayload {
  groupId: number;
  threadId: number;
  /** The member the event is about (joined / left / kicked / role-changed). */
  userId?: number;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
  /** Who performed the action (the inviter / operator). */
  byUserId?: number;
  /** GROUP_UPDATED fields. */
  name?: string;
  avatar?: string;
}

/** The five group-lifecycle events the backend fans (sse.service.ts GROUP_SSE). */
const GROUP_EVENTS = new Set<string>([
  'GROUP_UPDATED',
  'GROUP_MEMBER_JOINED',
  'GROUP_MEMBER_LEFT',
  'GROUP_MEMBER_KICKED',
  'GROUP_ROLE_CHANGED',
]);

/**
 * Routes the backend's group-lifecycle SSE events to the right client-side state — the missing piece
 * that kept group chat from feeling "live" (previously these frames were forwarded to `eventSubject`
 * but only `NEW_MESSAGE` was consumed, so every group event was silently dropped).
 *
 * - GROUP_UPDATED → {@link ConversationListService.applyGroupUpdate} so the rename / new avatar land in
 *   the conversation list (and any view reading the shared store) in real time.
 * - A membership/role event targeting THIS user → self effect only:
 *     • my JOIN  → reload my list (the new group thread appears)
 *     • my ROLE  → update my role on the item + toast ("You are now …")
 *     • my KICK  → drop the thread + toast ("You were removed …")
 * - A membership/role event targeting SOMEONE ELSE → re-emit on {@link rosterChanged$} so any open
 *   GroupInfoComponent for that group reloads its roster. The conversation-list item itself is
 *   unaffected (it shows the thread, not its members).
 *
 * Root singleton, subscribes in its constructor (mirrors how WebsocketService self-starts). It must be
 * injected for the lifetime of the app — HomeComponent injects it.
 */
@Injectable({ providedIn: 'root' })
export class GroupEventService implements OnDestroy {
  private readonly ws = inject(WebsocketService);
  private readonly convList = inject(ConversationListService);
  private readonly userService = inject(UserService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);

  /** Fired (with the groupId) whenever a roster change lands while someone else joined / left / was
   *  kicked / promoted. GroupInfoComponent filters to its own groupId and reloads its roster. */
  readonly rosterChanged$ = new Subject<number>();

  private readonly sub: Subscription;

  constructor() {
    this.sub = this.ws.eventSubject
      .pipe(filter((m) => GROUP_EVENTS.has(m.event) && m.data !== undefined))
      .subscribe((m) => this.handle(m.event, m.data as GroupEventPayload));
  }

  private handle(event: string, p: GroupEventPayload): void {
    if (event === 'GROUP_UPDATED') {
      this.convList.applyGroupUpdate(p.threadId, { name: p.name, avatar: p.avatar });
      return;
    }
    const me = this.userService.sessionProfile()?.id;
    const targetsMe = p.userId != null && p.userId === me;
    // Resolve the display name BEFORE any removal, so a self-kick toast can still read it.
    const groupName =
      this.convList.items().find((t) => t.threadId === p.threadId)?.group?.name
      ?? this.transloco.translate('errors.theGroup');
    if (targetsMe) {
      switch (event) {
        case 'GROUP_MEMBER_JOINED':
          // I just joined (this session or another). My list does not yet hold the thread → fetch it,
          // promoting the new group to the top with a FLIP enter animation.
          this.convList.markTopOnNextUpdate(p.threadId);
          this.convList.load();
          break;
        case 'GROUP_MEMBER_KICKED':
          this.convList.removeThread(p.threadId);
          this.toast(this.transloco.translate('errors.removedFromGroup', { group: groupName }));
          break;
        case 'GROUP_ROLE_CHANGED':
          if (p.role) {
            this.convList.applyRole(p.threadId, p.role);
            const roleLabel = this.transloco.translate('errors.role.' + p.role.toLowerCase());
            this.toast(this.transloco.translate('errors.nowRole', { role: roleLabel, group: groupName }));
          }
          break;
        case 'GROUP_MEMBER_LEFT':
          // Defensive: the backend does not fan LEFT to the leaver, but handle it anyway.
          this.convList.removeThread(p.threadId);
          break;
      }
      return;
    }
    // Someone else's membership / role changed — refresh any open roster for this group.
    this.rosterChanged$.next(p.groupId);
  }

  private toast(message: string): void {
    this.snackBar.open(message, this.transloco.translate('common.ok'), { duration: 4000 });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
