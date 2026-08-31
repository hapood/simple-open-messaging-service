import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type {
  DomainCommand,
  DomainCommandHandler,
} from '../domain-command/domain-command.types.js';
import { FederationService } from '../federation/federation.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { ThreadParticipantService } from './thread-participant.service.js';

@Injectable()
export class EndFriendshipCommandHandler
  implements DomainCommandHandler, OnModuleInit, OnModuleDestroy
{
  readonly commandType = DomainCommandType.END_FRIENDSHIP;
  private readonly logger = new Logger(EndFriendshipCommandHandler.name);
  private unregister?: () => void;

  constructor(
    private readonly dispatcher: DomainCommandDispatcherService,
    private readonly participants: ThreadParticipantService,
    private readonly federation: FederationService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<
      MessageFanoutService,
      'dispatchToUsers'
    >,
  ) {}

  onModuleInit(): void {
    this.unregister = this.dispatcher.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async execute(command: DomainCommand): Promise<void> {
    const { actorUserId, threadId, deleteData } = readCommand(command);
    const ended = await this.participants.endP2P(
      threadId,
      actorUserId,
      deleteData,
    );

    for (const domain of ended.statePeers) {
      void this.federation
        .pushDiscoveryHwm(domain)
        .catch((error: unknown) =>
          this.logger.warn(
            `friendship-end discovery wake failed for ${domain}`,
            error,
          ),
        );
    }
    if (ended.systemMessage && this.messageFanout) {
      void this.messageFanout
        .dispatchToUsers(ended.systemMessage, ended.localRecipientIds)
        .catch((error: unknown) =>
          this.logger.warn('friendship-end message wake failed', error),
        );
    }
  }
}

function readCommand(command: DomainCommand): {
  actorUserId: number;
  threadId: number;
  deleteData: boolean;
} {
  if (command.aggregateType !== 'USER_PAIR') {
    throw new Error('end-friendship command has the wrong aggregate type');
  }
  if (command.actorUserId === null) {
    throw new Error('end-friendship command has no actor');
  }
  const { threadId, deleteData } = command.payload;
  if (!Number.isSafeInteger(threadId) || (threadId as number) < 1) {
    throw new Error('end-friendship command has an invalid thread ID');
  }
  if (typeof deleteData !== 'boolean') {
    throw new Error('end-friendship command has an invalid deleteData flag');
  }
  return {
    actorUserId: command.actorUserId,
    threadId: threadId as number,
    deleteData,
  };
}
