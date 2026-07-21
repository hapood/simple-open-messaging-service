import { Injectable, Logger } from '@nestjs/common';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SseService } from '../gateway/sse.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { ContentType } from '../prisma/generated/client.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import type { ReportActionDto } from '../dto/notification.dto.js';

/**
 * Handles a notification action reported back via `POST /notifications/action` — the round-trip closure for
 * the descriptor's `actions[]` buttons (mark-all-read, reply). The handler reuses the SAME pipelines the
 * interactive UI uses, so an action taken from the shade has identical semantics + fan-out to one taken
 * in-app:
 *  - `mark-all-read` → `ThreadParticipantService.advanceReadCursor` per covered thread + an
 *    `onReadCursor` SSE frame (multi-device badge sync), exactly like `POST /thread/mark-read`;
 *  - `reply`        → `MessageService.writeMsgToThread` (PURE_TEXT) + `MessageFanoutService.dispatch`
 *    (seq allocation + SSE/push/federation fan-out), exactly like `POST /send-message`;
 *  - `open` / unknown → no-op (body-tap telemetry; the client opens the thread itself).
 *
 * Never throws — a notification action is best-effort fire-and-forget from a shade button; a transient
 * failure just means the action didn't land (the user retries in-app). Membership-gated: only threads the
 * caller actively participates in are touched (the descriptor only ever names such threads, but this is the
 * server-side backstop).
 */
@Injectable()
export class NotificationActionService {
  private readonly logger = new Logger(NotificationActionService.name);

  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly fanout: MessageFanoutService,
    private readonly sse: SseService,
    private readonly quota: QuotaService,
  ) {}

  async handleAction(userId: number, dto: ReportActionDto): Promise<void> {
    try {
      switch (dto.actionId) {
        case 'mark-all-read': {
          const threadIds = dto.threadIds ?? (dto.threadId != null ? [dto.threadId] : []);
          await this.markAllRead(userId, threadIds);
          return;
        }
        case 'reply': {
          const text = dto.replyText?.trim();
          if (dto.threadId != null && text) await this.reply(userId, dto.threadId, text);
          return;
        }
        default:
          // 'open' (body-tap) and any unknown id — telemetry only; no server-side effect.
          return;
      }
    } catch (e) {
      this.logger.warn(`notif action ${dto.actionId} failed: ${(e as Error).message}`);
    }
  }

  /** Mark every covered thread read (advance the per-user read cursor to the thread's newest message) +
   *  fan an `onReadCursor` SSE frame to the caller's OTHER online devices so their badge clears. Skips
   *  threads the caller is not an active participant of. */
  private async markAllRead(userId: number, threadIds: number[]): Promise<void> {
    for (const threadId of threadIds) {
      const thread = await this.messageService.findThread(threadId);
      const last = thread?.lastMessageSeq ?? null;
      if (last === null) continue; // empty thread — nothing to mark
      const p = await this.participantService.findParticipant(userId, threadId);
      if (!p || p.leftAt !== null) continue; // not an active member — skip
      const moved = await this.participantService.advanceReadCursor(userId, threadId, last);
      if (moved) {
        // The advanceReadCursor "did it move?" return suppresses the frame for an idempotent/stale mark.
        this.sse.onReadCursor(
          userId,
          serializeBody({ threadId, lastReadSeq: last }),
        );
      }
    }
  }

  /** Send a PURE_TEXT reply through the unified send pipeline (seq allocation + fan-out + federation hint),
   *  consuming one 'messages' quota unit — identical to `POST /send-message`. Membership-gated + quota-
   *  gated; a quota exhaustion is a silent no-op (the user retries in-app, where the quota error surfaces). */
  private async reply(userId: number, threadId: number, text: string): Promise<void> {
    const p = await this.participantService.findParticipant(userId, threadId);
    if (!p || p.leftAt !== null) return; // not an active member — refuse silently
    const q = await this.quota.tryTickLocal('messages');
    if (q.exceeded) return; // over the daily quota — surface in-app, not from the shade
    const data = await this.messageService.writeMsgToThread(
      userId,
      threadId,
      text,
      ContentType.PURE_TEXT,
    );
    // Fire-and-forget fan-out (SSE + push + notif + federation) — same as the send-message controller.
    void this.fanout.dispatch(data);
  }
}
