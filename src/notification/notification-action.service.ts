import { Injectable, Logger } from '@nestjs/common';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { ContentType, ThreadParticipantState } from '../database/enums.js';
import type { ReportActionDto } from '../dto/notification.dto.js';
import { stringifyTextMessageContent } from '../../shared/text-message-content.js';

/**
 * Handles a notification action reported back via `POST /notifications/action` — the round-trip closure for
 * the descriptor's `actions[]` buttons. Today only `reply` reaches the backend:
 *  - `reply` → `MessageService.writeMsgToThread` (PURE_TEXT) + `MessageFanoutService.dispatch`
 *    (seq allocation + SSE/push/federation fan-out), exactly like `POST /send-message`;
 *  - `dismiss` / `open` / unknown → no-op. The away-summary's `dismiss` button is a PURE frontend op: the
 *    client just closes the shade (cancels the notification). It never POSTs, and the backend does NOT
 *    advance the read watermark on the shade's behalf — unread is cleared the normal way, when the user
 *    opens a thread via `POST /thread/mark-read`. The `dismiss` action is still authored in the descriptor so
 *    each client renders the (server-localized) button, but the tap is handled locally.
 *
 * Never throws — a notification action is best-effort fire-and-forget from a shade button; a transient
 * failure just means the action didn't land (the user retries in-app). Membership-gated: only threads the
 * caller actively participates in are touched.
 */
@Injectable()
export class NotificationActionService {
  private readonly logger = new Logger(NotificationActionService.name);

  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly fanout: MessageFanoutService,
  ) {}

  async handleAction(userId: number, dto: ReportActionDto): Promise<void> {
    try {
      switch (dto.actionId) {
        case 'reply': {
          const text = dto.replyText?.trim();
          if (dto.threadId != null && text)
            await this.reply(userId, dto.threadId, text);
          return;
        }
        default:
          // 'dismiss' (pure frontend — closes the shade, never POSTed), 'open' (body-tap telemetry), and any
          // unknown id — no server-side effect.
          return;
      }
    } catch (e) {
      this.logger.warn(
        `notif action ${dto.actionId} failed: ${(e as Error).message}`,
      );
    }
  }

  /** Send a PURE_TEXT reply through the unified send pipeline (seq allocation + fan-out + federation hint).
   *  Membership-gated; personal-account quota will be applied here with the other local send paths. */
  private async reply(
    userId: number,
    threadId: number,
    text: string,
  ): Promise<void> {
    const p = await this.participantService.findParticipant(userId, threadId);
    if (!p || p.state !== ThreadParticipantState.ESTABLISHED) return;
    const data = await this.messageService.writeMsgToThread(
      userId,
      threadId,
      stringifyTextMessageContent({ text }),
      ContentType.PURE_TEXT,
    );
    // Fire-and-forget fan-out (SSE + push + notif + federation) — same as the send-message controller.
    void this.fanout.dispatch(data);
  }
}
