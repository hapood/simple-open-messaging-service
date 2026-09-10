import { Injectable } from '@nestjs/common';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import type { SystemMessageInput } from '../message/system-message.js';

export interface FederationLocalSystemMessage {
  threadId: number;
  event: SystemMessageInput;
  message?: PublicMessage;
}

/** Writes missing local timeline notices. Every system-message write admits its
 * device fanout in the same transaction; already committed notices need no work. */
@Injectable()
export class FederationLocalSystemMessagePublisher {
  constructor(private readonly messages: MessageService) {}

  async publish(status: FederationLocalSystemMessage): Promise<void> {
    if (status.message) return;
    await this.messages.tryWriteSystemMessage(status.threadId, status.event);
  }
}
