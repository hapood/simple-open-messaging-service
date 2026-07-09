import { Injectable } from '@nestjs/common';
import { MessageService } from '../message/message.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';

/**
 * One thread's unread state, in the minimal shape the notification paths need. This is the single
 * shape produced and consumed by:
 *  - POST /notifications/missed (the WorkManager poller's HTTP response)
 *  - GET /notifications/stream (the Android FGS's live SSE feed — each frame is `UnreadThreadItem[]`)
 *  - the FGS / WorkManager / FCM notification renderers on-device (coalesced into ONE away-notification)
 *
 * `latestMessageId` is the per-thread dedup cursor (BigInt→string), shared with FCM so the three
 * background paths never double-notify the same message.
 */
export interface UnreadThreadItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  latestMessageId: string | null;
}

/**
 * Builds the "what did I miss" unread-threads snapshot for a user — the reusable building block
 * behind the notification surface. Extracted from NotificationController.missed() so the SAME
 * hydration feeds both the HTTP poll endpoint and the live notification stream pushed to the
 * Android foreground service (and, via the send-message fan-out, kept current as new messages land).
 *
 * Reuses the existing per-thread unread query (`countUnreadByThread`, one SQL query over the
 * Message(threadId,id) index) and the P2P/group display-name resolution. Newest-unread-first.
 *
 * `providedIn`-less on purpose: declared as a provider in AppModule so both NotificationController
 * and MessageController (both declared in AppModule) can inject it.
 */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly userService: UserService,
    private readonly groupService: GroupService,
  ) {}

  /** The current unread-threads snapshot for `userId`, newest lastMessageAt first. Empty array when
   *  the user has no active threads or none with unread. */
  async buildUnreadSnapshot(userId: number): Promise<UnreadThreadItem[]> {
    const list = await this.participantService.queryParticipants({
      where: { userId, leftAt: null },
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    if (list.length === 0) return [];

    const unread = await this.messageService.countUnreadByThread(
      userId,
      list.map((p) => p.threadId),
    );
    // Unread + NOT muted: muted conversations never trigger the away-notification (the user explicitly
    // silenced them). Unread is still tracked for the in-app list badge — this filter is about the
    // heads-up notification surface only.
    const withUnread = list.filter(
      (p) => !p.muted && (unread.get(p.threadId) ?? 0) > 0,
    );
    if (withUnread.length === 0) return [];

    // Most-recent unread first — the poller notifies about the freshest conversation.
    withUnread.sort((a, b) => {
      const ta = a.thread.lastMessageAt?.getTime() ?? -Infinity;
      const tb = b.thread.lastMessageAt?.getTime() ?? -Infinity;
      return tb - ta || a.threadId - b.threadId;
    });

    // Resolve P2P display names (the peer's User.name, falling back to account).
    const p2pThreadIds = withUnread
      .filter((p) => p.thread.type === 'P2P')
      .map((p) => p.threadId);
    const peers = await this.participantService.findP2PPeers(p2pThreadIds, userId);
    const peerUsers =
      p2pThreadIds.length > 0
        ? await this.userService.queryUsers({
            where: { id: { in: peers.map((p) => p.userId) }, isDeleted: false },
          })
        : [];
    const peerNameByThread = new Map<number, string>();
    peers.forEach((p) => {
      const u = peerUsers.find((u) => u.id === p.userId) as
        | (typeof peerUsers)[number]
        | undefined;
      peerNameByThread.set(p.threadId, u?.name || 'Unknown');
    });

    // Resolve GROUP display names (Group.name by threadId).
    const groupThreadIds = withUnread
      .filter((p) => p.thread.type === 'GROUP')
      .map((p) => p.threadId);
    const groupByThread =
      await this.groupService.resolveGroupUsersByThreadIds(groupThreadIds);
    const groupNameByThread = new Map<number, string>();
    groupByThread.forEach((gu, threadId) => groupNameByThread.set(threadId, gu.name));

    return withUnread.map((p) => ({
      threadId: p.threadId,
      type: p.thread.type,
      displayName:
        p.thread.type === 'P2P'
          ? (peerNameByThread.get(p.threadId) ?? 'Unknown')
          : (groupNameByThread.get(p.threadId) ?? 'Unknown'),
      unreadCount: unread.get(p.threadId) ?? 0,
      latestMessageId: p.thread.lastMessageSeq?.toString() ?? null,
    }));
  }
}
