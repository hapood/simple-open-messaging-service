import type { AccountTarget } from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';

export interface FederationLocalSystemMessage {
  actorUserId: AccountTarget;
  threadId: number;
  type: Exclude<SystemMessageType, 'CALL_ENDED'>;
  subjectUserId?: AccountTarget;
  message?: PublicMessage;
}

/** Writes missing local timeline notices. Every system-message write admits its
 * device fanout in the same transaction; already committed notices need no work. */
@Injectable()
export class FederationLocalSystemMessagePublisher {
  constructor(private readonly messages: MessageService) {}

  async publish(status: FederationLocalSystemMessage): Promise<void> {
    if (status.message) return;
    await this.messages.tryWriteSystemMessage(
      status.threadId,
      status.type,
      status.subjectUserId,
      { actorUserId: status.actorUserId },
    );
  }
}
