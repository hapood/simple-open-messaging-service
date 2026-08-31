import type { domainCommand } from '../database/schema.js';

export type DomainCommand = typeof domainCommand.$inferSelect;

export interface DomainCommandHandler {
  readonly commandType: string;
  execute(command: DomainCommand): Promise<void>;
}
