import { Injectable } from '@nestjs/common';
import type {
  DomainCommand,
  DomainCommandHandler,
} from './domain-command.types.js';

@Injectable()
export class DomainCommandDispatcherService {
  private readonly handlers = new Map<string, DomainCommandHandler>();

  get supportedCommandTypes(): readonly string[] {
    return [...this.handlers.keys()];
  }

  register(handler: DomainCommandHandler): () => void {
    if (!/^[A-Z][A-Z0-9_]*$/.test(handler.commandType)) {
      throw new TypeError('invalid domain command handler type');
    }
    if (this.handlers.has(handler.commandType)) {
      throw new Error(
        `domain command handler already registered: ${handler.commandType}`,
      );
    }
    this.handlers.set(handler.commandType, handler);

    return () => {
      if (this.handlers.get(handler.commandType) === handler) {
        this.handlers.delete(handler.commandType);
      }
    };
  }

  async execute(command: DomainCommand): Promise<void> {
    const handler = this.handlers.get(command.commandType);
    if (!handler) {
      throw new Error(
        `no handler registered for domain command: ${command.commandType}`,
      );
    }
    await handler.execute(command);
  }
}
