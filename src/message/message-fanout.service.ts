import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { PublicMessage } from './message.service.js';
import { PushService } from '../push/push.service.js';
import { FederationService } from '../federation/federation.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { ContentType } from '../database/enums.js';
import { planLiveDelivery } from './message-delivery-plan.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';

const RECIPIENT_BATCH_SIZE = 50;

interface ThreadFanoutState {
  activeSeq: number;
  pending: PublicMessage | null;
  runner: Promise<void>;
}

/**
 * Unified post-commit fan-out for every locally-authored message, shared by the text send path
 * (MessageController.sendMessage → writeMsgToThread) and the staged-media promote path
 * (UploadController → MessageService.promoteStaged). Both hand the just-committed, id-stripped
 * Message to {@link dispatch}, which:
 *   - wakes every active participant's durable client State Feed except those who block the sender;
 *   - dispatches push (FCM / Web Push) + the Android FGS unread snapshot to non-muted, non-sender
 *     recipients (fire-and-forget — push failures never break delivery);
 *   - marks the conversation dirty in the federation outbound hint buffer so the peer pulls (the
 *     receiver's own message-create + fan-out is independent; this is only the "new msg available"
 *     nudge), fire-and-forget.
 *
 * The federation inbound path does not use this service; it computes its own recipient set and emits
 * the same State Feed high-watermark wake-up after commit.
 *
 * Fire-and-forget: the caller does NOT await dispatch(). The send/promote endpoint's job is to PERSIST
 * the message (its response confirms "saved"); recipient fan-out is a best-effort side effect that runs
 * off the request critical path. The wake-up may therefore land just after the HTTP 200. The client
 * reconciles from the durable State Feed, so wake-before-pull and pull-before-wake are both idempotent.
 * dispatch never rejects (it logs + swallows its own errors) so `void dispatch(...)` is
 * always safe; a fan-out failure degrades to "recipients catch up on next poll/chat-open", never to a
 * lost message (the row is already committed before dispatch is called).
 */
@Injectable()
export class MessageFanoutService {
  private readonly logger = new Logger(MessageFanoutService.name);
  private readonly threadFanouts = new Map<number, ThreadFanoutState>();

  constructor(
    private readonly pushService: PushService,
    @Inject(forwardRef(() => FederationService))
    private readonly federation: Pick<FederationService, 'notifyOnSend'>,
    private readonly participantService: AccountThreadStateService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async dispatch(message: PublicMessage): Promise<void> {
    const current = this.threadFanouts.get(message.threadId);
    if (current) {
      const coveredThrough = Math.max(
        current.activeSeq,
        current.pending?.seq ?? 0,
      );
      if (message.seq > coveredThrough) current.pending = message;
      await current.runner;
      return;
    }

    const state: ThreadFanoutState = {
      activeSeq: 0,
      pending: message,
      runner: Promise.resolve(),
    };
    this.threadFanouts.set(message.threadId, state);
    state.runner = this.drainThread(message.threadId, state);
    await state.runner;
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
      const sender = participants.find(
        (participant) =>
          participant.account === message.creator?.account &&
          participant.domain === message.creator?.domain,
      );
      for (const batch of batches(participants, RECIPIENT_BATCH_SIZE)) {
        const plan = planLiveDelivery(batch, sender?.userId ?? null);
        const feedEnds = await Promise.all(
          plan.wakeUserIds.map(async (userId) => ({
            userId,
            feedId: await this.clientStateFeed.readEndId(userId),
          })),
        );
        this.clientStateFeed.notifyFeedUpdates(feedEnds);
        void this.pushService.dispatchForMessage(
          plan.pushUserIds.map((userId) => ({ userId })),
          message.seq,
        );
        await yieldToEventLoop();
      }
    } catch (e) {
      this.logger.warn(
        `explicit message fan-out failed (seq ${message.seq}): ${(e as Error).message}`,
      );
    }
  }

  private async drainThread(
    threadId: number,
    state: ThreadFanoutState,
  ): Promise<void> {
    try {
      while (state.pending) {
        const message = state.pending;
        state.pending = null;
        state.activeSeq = message.seq;
        try {
          await this.fanout(
            message,
            () => (state.pending?.seq ?? 0) > message.seq,
          );
        } catch (e) {
          // Best-effort delivery: never reject. The message is already committed; a fan-out failure
          // means recipients catch up on their next poll or chat open.
          this.logger.warn(
            `message fan-out failed (seq ${message.seq}): ${(e as Error).message}`,
          );
        }
      }
    } finally {
      if (this.threadFanouts.get(threadId) === state)
        this.threadFanouts.delete(threadId);
    }
  }

  private async fanout(
    message: PublicMessage,
    shouldYield: () => boolean,
  ): Promise<void> {
    const senderAddress = message.creator;
    const threadId = message.threadId;
    // Unified fan-out: every active participant of the thread (P2P = both sides, GROUP = all members).
    const participants =
      await this.participantService.getActiveParticipantUserIds(threadId);
    // BLOCK: a recipient who blocks the sender must not receive the message wake or push.
    const senderUserId = participants.find(
      (participant) =>
        participant.account === senderAddress?.account &&
        participant.domain === senderAddress?.domain,
    )?.userId;
    // Wake every authorized peer with the latest durable discovery HWM. The body remains pull-only via
    // the peer-global /message-feed; this notification is ephemeral and safe to lose.
    // This service handles locally-authored rows. Their local seq is the wire originSeq until the
    // self-authored delivery receipt returns and fills the nullable receipt columns.
    if (message.contentType !== ContentType.SYSTEM && senderAddress !== null)
      void this.federation.notifyOnSend(senderAddress, threadId, message.seq);

    for (const batch of batches(participants, RECIPIENT_BATCH_SIZE)) {
      if (shouldYield()) return;
      const plan = planLiveDelivery(batch, senderUserId ?? null);
      const feedEnds = await Promise.all(
        plan.wakeUserIds.map(async (userId) => ({
          userId,
          feedId: await this.clientStateFeed.readEndId(userId),
        })),
      );
      this.clientStateFeed.notifyFeedUpdates(feedEnds);
      // Push wake-up additionally excludes muted recipients and the sender. The payload is an
      // identity-only high-water mark, so a newer sequence safely covers an unstarted old batch.
      void this.pushService.dispatchForMessage(
        plan.pushUserIds.map((userId) => ({ userId })),
        message.seq,
      );
      await yieldToEventLoop();
    }
  }
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    result.push(items.slice(start, start + size));
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
