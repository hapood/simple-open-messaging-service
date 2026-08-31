import { Injectable, Logger } from '@nestjs/common';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { SseService } from '../gateway/sse.service.js';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';

export interface FederationLocalSystemMessage {
  actorUserId: number;
  threadId: number;
  type: SystemMessageType;
  subjectUserId?: number;
  message?: PublicMessage;
  recipientUserIds?: number[];
}

/** Publishes committed federation timeline notices to their local recipients. */
@Injectable()
export class FederationLocalSystemMessagePublisher {
  private readonly logger = new Logger(
    FederationLocalSystemMessagePublisher.name,
  );

  constructor(
    private readonly messages: MessageService,
    private readonly participants: ThreadParticipantService,
    private readonly sse: SseService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async publish(status: FederationLocalSystemMessage): Promise<void> {
    if (status.message && status.recipientUserIds) {
      for (const recipientUserId of status.recipientUserIds)
        this.sse.onNewMessage(
          recipientUserId,
          status.threadId,
          status.message.seq,
          status.message.createdAt.getTime(),
          await this.clientStateFeed.readEndId(recipientUserId),
        );
      return;
    }
    const message = await this.messages.tryWriteSystemMessage(
      status.threadId,
      status.type,
      status.subjectUserId,
      {
        actorUserId: status.actorUserId,
        recipientUserIds: status.recipientUserIds,
      },
    );
    if (!message) return;
    try {
      const recipients = status.recipientUserIds
        ? status.recipientUserIds.map((userId) => ({ userId, blocked: false }))
        : await this.participants.getActiveParticipantUserIds(status.threadId);
      for (const recipient of recipients) {
        if (
          !recipient.blocked &&
          (status.recipientUserIds !== undefined ||
            recipient.userId !== status.actorUserId)
        )
          this.sse.onNewMessage(
            recipient.userId,
            status.threadId,
            message.seq,
            message.createdAt.getTime(),
            await this.clientStateFeed.readEndId(recipient.userId),
          );
      }
    } catch (error) {
      this.logger.error(
        `failed to publish local system message ${status.type} for thread ${status.threadId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
