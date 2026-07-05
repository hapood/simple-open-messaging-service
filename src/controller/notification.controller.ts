import {
  Controller,
  Post,
  Get,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationTokenGuard } from '../auth/notification-token.guard.js';
import { MessageService } from '../message/message.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Read-only "what did I miss" endpoint consumed by the Android NotificationSyncWorker (background
 * poll) using a scoped notification token (NotificationTokenGuard). Returns the threads with unread >
 * 0 + a display name per thread, so the poller can post a local notification "{name} sent you new
 * messages while you were away" without holding a 15-minute access token.
 *
 * Hydration mirrors UserController.queryValidThread (the conversation list) but is paginated-light:
 * no preview/sender fields, filtered to unread>0, projected to the minimal notification shape.
 */
@ApiTags('notification')
@ApiBearerAuth()
@Controller()
export class NotificationController {
  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly userService: UserService,
    private readonly groupService: GroupService,
  ) {}

  /** Public: the VAPID public key the browser needs to subscribe via PushManager.subscribe. Public
   *  (VAPID public keys are safe to expose), unauthenticated, single source of truth — avoids drifting
   *  between a hardcoded client constant and the backend's configured VAPID_PRIVATE_KEY. */
  @HttpCode(HttpStatus.OK)
  @Get('notifications/vapid-key')
  @ApiOperation({ summary: 'VAPID public key for Web Push subscription (browser)' })
  vapidKey(): ApiResult {
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { publicKey: process.env.VAPID_PUBLIC_KEY ?? '' },
    };
  }

  @UseGuards(NotificationTokenGuard)
  @HttpCode(HttpStatus.OK)
  @Post('notifications/missed')
  @ApiOperation({ summary: 'Threads with unread messages + display names (background poller)' })
  async missed(@Request() req): Promise<ApiResult> {
    const me = req.user.userId as number;

    // Active threads only (leftAt null), newest lastMessageAt first — same ordering as the conv list.
    const list = await this.participantService.queryParticipants({
      where: { userId: me, leftAt: null },
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    if (list.length === 0) {
      return { code: BusinessCode.OK, message: 'successful', data: [] };
    }

    // Batched unread count via the Message(threadId,id) index — the single reusable building block.
    const unread = await this.messageService.countUnreadByThread(
      me,
      list.map((p) => p.threadId),
    );
    const withUnread = list.filter((p) => (unread.get(p.threadId) ?? 0) > 0);
    if (withUnread.length === 0) {
      return { code: BusinessCode.OK, message: 'successful', data: [] };
    }
    // Most-recent unread first — the poller notifies about the freshest conversation.
    withUnread.sort((a, b) => {
      const ta = a.thread.lastMessageAt?.getTime() ?? -Infinity;
      const tb = b.thread.lastMessageAt?.getTime() ?? -Infinity;
      return tb - ta || a.threadId - b.threadId;
    });

    // Resolve P2P display names (the peer's UserExtra.name, falling back to uniqName).
    const p2pThreadIds = withUnread
      .filter((p) => p.thread.type === 'P2P')
      .map((p) => p.threadId);
    const peers = await this.participantService.findP2PPeers(p2pThreadIds, me);
    const peerByThread = new Map(peers.map((p) => [p.threadId, p.userId]));
    const peerUsers =
      p2pThreadIds.length > 0
        ? await this.userService.queryUsers({
            where: { id: { in: peers.map((p) => p.userId) }, isDeleted: false },
            include: { userExtra: true },
          })
        : [];
    const peerNameByThread = new Map<number, string>();
    peers.forEach((p) => {
      const u = peerUsers.find((u) => u.id === p.userId) as
        | (typeof peerUsers)[number]
        | undefined;
      const extra = (u as { userExtra?: { name?: string } | null } | undefined)?.userExtra;
      peerNameByThread.set(p.threadId, extra?.name || u?.uniqName || 'Unknown');
    });

    // Resolve GROUP display names (Group.name by threadId).
    const groupThreadIds = withUnread
      .filter((p) => p.thread.type === 'GROUP')
      .map((p) => p.threadId);
    const groups =
      groupThreadIds.length > 0
        ? await this.groupService.queryGroups({ where: { threadId: { in: groupThreadIds } } })
        : [];
    const groupNameByThread = new Map<number, string>();
    groups.forEach((g) => groupNameByThread.set(g.threadId, g.name));

    const data = withUnread.map((p) => ({
      threadId: p.threadId,
      type: p.thread.type,
      displayName:
        p.thread.type === 'P2P'
          ? (peerNameByThread.get(p.threadId) ?? 'Unknown')
          : (groupNameByThread.get(p.threadId) ?? 'Unknown'),
      unreadCount: unread.get(p.threadId) ?? 0,
      // The thread's denormalized newest message id (BigInt→string). The WorkManager poller uses this
      // as a per-thread dedup cursor shared with FCM: only notify when it advances past the last value
      // the device notified, so FCM (real-time) and WorkManager (periodic) never double-notify.
      latestMessageId: p.thread.lastMessageId?.toString() ?? null,
    }));

    return { code: BusinessCode.OK, message: 'successful', data };
  }
}
