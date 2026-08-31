import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, notExists, notInArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../database/database.service.js';
import { domainCommand } from '../database/schema.js';
import type { DomainCommand } from './domain-command.types.js';

@Injectable()
export class DomainCommandStoreService {
  constructor(private readonly database: DatabaseService) {}

  async findEligible(
    commandTypes: readonly string[],
    limit: number,
  ): Promise<DomainCommand[]> {
    if (commandTypes.length === 0 || limit <= 0) {
      return [];
    }

    const earlier = alias(domainCommand, 'earlier_domain_command');
    const processing = alias(domainCommand, 'processing_domain_command');
    return this.database.db
      .select()
      .from(domainCommand)
      .where(
        and(
          eq(domainCommand.status, 'PENDING'),
          inArray(domainCommand.commandType, [...commandTypes]),
          notExists(
            this.database.db
              .select({ id: earlier.id })
              .from(earlier)
              .where(
                and(
                  eq(earlier.aggregateKey, domainCommand.aggregateKey),
                  lt(earlier.id, domainCommand.id),
                  notInArray(earlier.status, ['SUCCEEDED', 'REJECTED']),
                ),
              ),
          ),
          notExists(
            this.database.db
              .select({ id: processing.id })
              .from(processing)
              .where(
                and(
                  eq(processing.aggregateKey, domainCommand.aggregateKey),
                  eq(processing.status, 'PROCESSING'),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(domainCommand.id))
      .limit(limit);
  }

  async findCheckpointedProcessing(
    commandType: string,
    limit: number,
  ): Promise<DomainCommand[]> {
    if (limit <= 0) return [];
    return this.database.db
      .select()
      .from(domainCommand)
      .where(
        and(
          eq(domainCommand.status, 'PROCESSING'),
          eq(domainCommand.commandType, commandType),
        ),
      )
      .orderBy(asc(domainCommand.id))
      .limit(limit);
  }

  async claim(commandId: bigint): Promise<DomainCommand | undefined> {
    const [claimed] = await this.database.db
      .update(domainCommand)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(
        and(
          eq(domainCommand.id, commandId),
          eq(domainCommand.status, 'PENDING'),
        ),
      )
      .returning();
    return claimed;
  }

  async markSucceeded(commandId: bigint): Promise<void> {
    await this.markTerminal(commandId, {
      status: 'SUCCEEDED',
      completedAt: new Date(),
      resultCode: null,
      lastError: null,
    });
  }

  async markRejected(commandId: bigint, resultCode: number): Promise<void> {
    await this.markTerminal(commandId, {
      status: 'REJECTED',
      completedAt: new Date(),
      resultCode,
      lastError: null,
    });
  }

  async markFailed(commandId: bigint, lastError: string): Promise<void> {
    await this.markTerminal(commandId, {
      status: 'FAILED',
      completedAt: new Date(),
      resultCode: null,
      lastError: lastError.slice(0, 1000),
    });
  }

  private async markTerminal(
    commandId: bigint,
    values: Pick<
      typeof domainCommand.$inferInsert,
      'status' | 'completedAt' | 'resultCode' | 'lastError'
    >,
  ): Promise<void> {
    const [updated] = await this.database.db
      .update(domainCommand)
      .set(values)
      .where(
        and(
          eq(domainCommand.id, commandId),
          eq(domainCommand.status, 'PROCESSING'),
        ),
      )
      .returning({ id: domainCommand.id });
    if (!updated) {
      throw new Error(
        `processing domain command ${commandId.toString()} could not be finalized`,
      );
    }
  }
}
