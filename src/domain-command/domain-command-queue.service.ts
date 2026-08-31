import { Injectable } from '@nestjs/common';
import { domainCommand } from '../database/schema.js';
import { DatabaseService } from '../database/database.service.js';
import {
  groupBusinessScopeKey,
  lockBusinessScopeInTx,
  type BusinessScopeAddress,
  userPairBusinessScopeKey,
} from '../invite/business-scope-lock.js';

export type DomainCommandAggregate =
  | {
      type: 'USER_PAIR';
      endpoints: readonly [BusinessScopeAddress, BusinessScopeAddress];
    }
  | {
      type: 'GROUP';
      address: BusinessScopeAddress;
    };

export interface EnqueueDomainCommandInput {
  aggregate: DomainCommandAggregate;
  commandType: string;
  actorUserId?: number;
  payload: Record<string, unknown>;
}

export interface EnqueueDomainCommandResult {
  commandId: bigint;
}

@Injectable()
export class DomainCommandQueueService {
  constructor(private readonly database: DatabaseService) {}

  async enqueue(
    input: EnqueueDomainCommandInput,
  ): Promise<EnqueueDomainCommandResult> {
    const commandType = validateCommandType(input.commandType);
    const actorUserId = validateActorUserId(input.actorUserId);
    const payload = cloneJsonObject(input.payload);
    const { aggregateType, aggregateKey } = resolveAggregate(input.aggregate);

    return this.database.db.transaction(async (tx) => {
      // This is a short-lived ordering lock only. Command execution takes the same business-scope
      // lock separately, so enqueueing does not extend the caller's business transaction.
      await lockBusinessScopeInTx(tx, aggregateKey);

      const [inserted] = await tx
        .insert(domainCommand)
        .values({
          aggregateType,
          aggregateKey,
          commandType,
          actorUserId,
          payload,
          status: 'PENDING',
        })
        .returning({ commandId: domainCommand.id });

      if (!inserted) {
        throw new Error('domain command insert returned no row');
      }
      return inserted;
    });
  }
}

function resolveAggregate(aggregate: DomainCommandAggregate): {
  aggregateType: 'USER_PAIR' | 'GROUP';
  aggregateKey: string;
} {
  let aggregateKey: string;
  if (aggregate.type === 'USER_PAIR') {
    validateAddress(aggregate.endpoints[0]);
    validateAddress(aggregate.endpoints[1]);
    aggregateKey = userPairBusinessScopeKey(aggregate.endpoints);
  } else {
    validateAddress(aggregate.address);
    aggregateKey = groupBusinessScopeKey(aggregate.address);
  }

  if (aggregateKey.length > 512) {
    throw new TypeError('domain command aggregate key exceeds 512 characters');
  }
  return { aggregateType: aggregate.type, aggregateKey };
}

function validateAddress(address: BusinessScopeAddress): void {
  if (
    !address.domain ||
    !address.account ||
    address.domain !== address.domain.trim() ||
    address.account !== address.account.trim()
  ) {
    throw new TypeError(
      'domain command aggregate address must be non-empty and normalized',
    );
  }
}

function validateCommandType(commandType: string): string {
  if (commandType.length > 64 || !/^[A-Z][A-Z0-9_]*$/.test(commandType)) {
    throw new TypeError('invalid domain command type');
  }
  return commandType;
}

function validateActorUserId(actorUserId: number | undefined): number | null {
  if (actorUserId === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError(
      'domain command actor user ID must be a positive integer',
    );
  }
  return actorUserId;
}

function cloneJsonObject(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new TypeError('domain command payload must be a plain object');
  }
  validateJsonValue(payload, new Set<object>());
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function validateJsonValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('domain command payload numbers must be finite');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError('domain command payload must contain only JSON values');
  }
  if (ancestors.has(value)) {
    throw new TypeError('domain command payload must not contain cycles');
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonValue(item, ancestors);
    }
  } else {
    if (!isPlainObject(value)) {
      throw new TypeError(
        'domain command payload must contain only plain objects',
      );
    }
    for (const item of Object.values(value)) {
      validateJsonValue(item, ancestors);
    }
  }
  ancestors.delete(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
