import type { AccountTarget } from '../user/account-address.js';
import { Injectable, Logger } from '@nestjs/common';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';

export interface FederationLocalSystemMessage {
  actorUserId: AccountTarget;
  threadId: number;
  type: SystemMessageType;
  subjectUserId?: AccountTarget;
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
    private readonly participants: AccountThreadStateService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async publish(status: FederationLocalSystemMessage): Promise<void> {
    if (status.message && status.recipientUserIds) {
      this.clientStateFeed.notifyFeedUpdates(
        await Promise.all(
          status.recipientUserIds.map(async (userId) => ({
            userId,
            feedId: await this.clientStateFeed.readEndId(userId),
          })),
        ),
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
      const wakeUserIds = recipients
        .filter(
          (recipient) =>
            !recipient.blocked &&
            (status.recipientUserIds !== undefined ||
              recipient.userId !== status.actorUserId),
        )
        .map((recipient) => recipient.userId);
      this.clientStateFeed.notifyFeedUpdates(
        await Promise.all(
          wakeUserIds.map(async (userId) => ({
            userId,
            feedId: await this.clientStateFeed.readEndId(userId),
          })),
        ),
      );
    } catch (error) {
      this.logger.error(
        `failed to publish local system message ${status.type} for thread ${status.threadId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
