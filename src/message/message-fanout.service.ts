import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { PublicMessage } from './message.service.js';
import { SseService } from '../gateway/sse.service.js';
import { PushService } from '../push/push.service.js';
import { FederationService } from '../federation/federation.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ContentType } from '../database/enums.js';
import { planLiveDelivery } from './message-delivery-plan.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';

/**
 * Unified NEW_MESSAGE fan-out for every locally-authored message, shared by the text send path
 * (MessageController.sendMessage → writeMsgToThread) and the staged-media promote path
 * (UploadController → MessageService.promoteStaged). Both hand the just-committed, id-stripped
 * Message to {@link dispatch}, which:
 *   - fans the full body over SSE to every active participant except those who block the sender;
 *   - dispatches push (FCM / Web Push) + the Android FGS unread snapshot to non-muted, non-sender
 *     recipients (fire-and-forget — push failures never break delivery);
 *   - marks the conversation dirty in the federation outbound hint buffer so the peer pulls (the
 *     receiver's own message-create + fan-out is independent; this is only the "new msg available"
 *     nudge), fire-and-forget.
 *
 * The federation inbound path (FederationService.storePulledMessage) does NOT use this — it computes
 * its own recipient set and fans out directly.
 *
 * Fire-and-forget: the caller does NOT await dispatch(). The send/promote endpoint's job is to PERSIST
 * the message (its response confirms "saved"); recipient fan-out is a best-effort side effect that runs
 * off the request critical path. The SSE frame may therefore land a hair after the HTTP 200 — that is
 * fine, because the client reconciles by seq/id (a poll-then-SSE or SSE-then-poll ordering is
 * idempotent). dispatch never rejects (it logs + swallows its own errors) so `void dispatch(...)` is
 * always safe; a fan-out failure degrades to "recipients catch up on next poll/chat-open", never to a
 * lost message (the row is already committed before dispatch is called).
 */
@Injectable()
export class MessageFanoutService {
  private readonly logger = new Logger(MessageFanoutService.name);

  constructor(
    private readonly sseService: SseService,
    private readonly pushService: PushService,
    @Inject(forwardRef(() => FederationService))
    private readonly federation: Pick<FederationService, 'notifyOnSend'>,
    private readonly participantService: ThreadParticipantService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async dispatch(message: PublicMessage): Promise<void> {
    try {
      await this.fanout(message);
    } catch (e) {
      // Best-effort delivery: never reject. The message is already committed; a fan-out failure just
      // means recipients pick it up on their next poll/chat-open instead of via this live push.
      this.logger.warn(
        `message fan-out failed (seq ${message.seq}): ${(e as Error).message}`,
      );
    }
  }

  /** Wake an explicit local recipient snapshot captured by the source transaction. */
  async dispatchToUsers(
    message: PublicMessage,
    recipientUserIds: readonly number[],
  ): Promise<void> {
    try {
      const participants =
        await this.participantService.getParticipantDeliverySettings(
          message.threadId,
          recipientUserIds,
        );
      const ts = message.createdAt.getTime();
      const sender = participants.find(
        (participant) =>
          participant.account === message.creator?.account &&
          participant.domain === message.creator?.domain,
      );
      const plan = planLiveDelivery(participants, sender?.userId ?? null);
      for (const userId of plan.sseUserIds)
        this.sseService.onNewMessage(
          userId,
          message.threadId,
          message.seq,
          ts,
          await this.clientStateFeed.readEndId(userId),
        );
      void this.pushService.dispatchForMessage(
        plan.pushUserIds.map((userId) => ({ userId })),
        message.threadId,
        message.seq,
      );
    } catch (e) {
      this.logger.warn(
        `explicit message fan-out failed (seq ${message.seq}): ${(e as Error).message}`,
      );
    }
  }

  private async fanout(message: PublicMessage): Promise<void> {
    const senderAddress = message.creator;
    const threadId = message.threadId;
    // Identity-only signal — every signal (SSE + push) carries only {threadId, seq, ts}; the body is
    // pulled by the client via THREAD_CONTENT_HEAD + /query-messages (single body source).
    const ts = message.createdAt.getTime();
    // Unified fan-out: every active participant of the thread (P2P = both sides, GROUP = all members).
    const participants =
      await this.participantService.getActiveParticipantUserIds(threadId);
    // BLOCK: a recipient who blocks the sender must not receive the message AT ALL (no SSE, no push —
    // the blocked user is invisible to the blocker's message stream).
    const senderUserId = participants.find(
      (participant) =>
        participant.account === senderAddress?.account &&
        participant.domain === senderAddress?.domain,
    )?.userId;
    const plan = planLiveDelivery(participants, senderUserId ?? null);
    for (const userId of plan.sseUserIds)
      this.sseService.onNewMessage(
        userId,
        threadId,
        message.seq,
        ts,
        await this.clientStateFeed.readEndId(userId),
      );
    // Push wake-up (FCM / Web Push): additionally exclude MUTED recipients (mute = suppress the heads-up
    // notification, NOT the in-app delivery) and the sender. Fire-and-forget.
    void this.pushService.dispatchForMessage(
      plan.pushUserIds.map((userId) => ({ userId })),
      threadId,
      message.seq,
    );
    // Wake every authorized peer with the latest durable discovery HWM. The body remains pull-only via
    // the peer-global /message-feed; this notification is ephemeral and safe to lose.
    // This service handles locally-authored rows. Their local seq is the wire originSeq until the
    // self-authored delivery receipt returns and fills the nullable receipt columns.
    if (message.contentType !== ContentType.SYSTEM && senderAddress !== null)
      void this.federation.notifyOnSend(senderAddress, threadId, message.seq);
  }
}
