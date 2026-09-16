import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type ExecutionKind = 'business' | 'task';

export interface ExecutionMeasurement {
  event: 'execution_measurement';
  executionId: string;
  kind: ExecutionKind;
  name: string;
  parentKind?: ExecutionKind;
  parentName?: string;
  outcome: 'SUCCEEDED' | 'FAILED';
  durationMs: number;
  sqlExecutionCount: number;
  databaseRoundTripCount: number;
  databaseFailureCount: number;
  databaseDurationMs: number;
  unfinishedDatabaseRoundTripCount: number;
  taskId?: string;
}

interface MutableExecutionScope {
  executionId: string;
  kind: ExecutionKind;
  name: string;
  parent?: Pick<MutableExecutionScope, 'kind' | 'name'>;
  taskId?: string;
  startedAt: bigint;
  sqlExecutionCount: number;
  databaseRoundTripCount: number;
  databaseFailureCount: number;
  databaseDurationNs: bigint;
  inFlightDatabaseRoundTripCount: number;
  closed: boolean;
}

interface ExecutionContext {
  executionId: string;
  scopes: readonly MutableExecutionScope[];
}

export interface ExecutionDefinition {
  kind: ExecutionKind;
  name: string;
  executionId?: string;
  taskId?: string;
}

interface MeasurementRunOptions {
  sampleRate?: number;
  publish?: (measurement: ExecutionMeasurement) => void;
}

const storage = new AsyncLocalStorage<ExecutionContext>();
const logger = new Logger('ExecutionMeasurement');

export function executionMeasurementSampleRate(): number {
  const raw = process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 1);
}

export async function runMeasuredExecution<T>(
  definition: ExecutionDefinition,
  operation: () => Promise<T>,
  options: MeasurementRunOptions = {},
): Promise<T> {
  const parentContext = storage.getStore();
  const sampleRate = options.sampleRate ?? executionMeasurementSampleRate();
  if (!parentContext && (sampleRate <= 0 || Math.random() >= sampleRate))
    return operation();

  const parent = parentContext?.scopes.at(-1);
  const scope: MutableExecutionScope = {
    executionId:
      parentContext?.executionId ?? definition.executionId ?? randomUUID(),
    kind: definition.kind,
    name: definition.name,
    ...(parent ? { parent: { kind: parent.kind, name: parent.name } } : {}),
    ...(definition.taskId ? { taskId: definition.taskId } : {}),
    startedAt: process.hrtime.bigint(),
    sqlExecutionCount: 0,
    databaseRoundTripCount: 0,
    databaseFailureCount: 0,
    databaseDurationNs: 0n,
    inFlightDatabaseRoundTripCount: 0,
    closed: false,
  };
  const context: ExecutionContext = {
    executionId: scope.executionId,
    scopes: [...(parentContext?.scopes ?? []), scope],
  };

  let outcome: ExecutionMeasurement['outcome'] = 'SUCCEEDED';
  try {
    return await storage.run(context, operation);
  } catch (error) {
    outcome = 'FAILED';
    throw error;
  } finally {
    scope.closed = true;
    const measurement = snapshot(scope, outcome);
    if (options.publish) options.publish(measurement);
    else logger.log(measurement);
  }
}

export function MeasureBusinessOperation(name: string): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const original = descriptor.value;
    if (typeof original !== 'function')
      throw new TypeError('business operation decorator requires a method');
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return runMeasuredExecution(
        { kind: 'business', name },
        () => Reflect.apply(original, this, args) as Promise<unknown>,
      );
    } as never;
  };
}

/** Records one SQL execution reported by the ORM. No SQL text or parameters are retained. */
export function recordSqlExecution(): void {
  for (const scope of activeScopes()) scope.sqlExecutionCount += 1;
}

/** Begins one PostgreSQL driver query, the practical client-side round-trip unit. */
export function beginDatabaseRoundTrip():
  | ((error?: unknown) => void)
  | undefined {
  const scopes = activeScopes();
  if (scopes.length === 0) return undefined;
  const startedAt = process.hrtime.bigint();
  for (const scope of scopes) {
    scope.databaseRoundTripCount += 1;
    scope.inFlightDatabaseRoundTripCount += 1;
  }
  let finished = false;
  return (error?: unknown) => {
    if (finished) return;
    finished = true;
    const duration = process.hrtime.bigint() - startedAt;
    for (const scope of scopes) {
      if (scope.closed) continue;
      scope.inFlightDatabaseRoundTripCount -= 1;
      scope.databaseDurationNs += duration;
      if (error !== undefined && error !== null)
        scope.databaseFailureCount += 1;
    }
  };
}

function activeScopes(): MutableExecutionScope[] {
  const scopes = storage.getStore()?.scopes;
  return scopes ? scopes.filter((scope) => !scope.closed) : [];
}

function snapshot(
  scope: MutableExecutionScope,
  outcome: ExecutionMeasurement['outcome'],
): ExecutionMeasurement {
  const elapsed = process.hrtime.bigint() - scope.startedAt;
  return {
    event: 'execution_measurement',
    executionId: scope.executionId,
    kind: scope.kind,
    name: scope.name,
    ...(scope.parent
      ? { parentKind: scope.parent.kind, parentName: scope.parent.name }
      : {}),
    outcome,
    durationMs: Number(elapsed) / 1_000_000,
    sqlExecutionCount: scope.sqlExecutionCount,
    databaseRoundTripCount: scope.databaseRoundTripCount,
    databaseFailureCount: scope.databaseFailureCount,
    databaseDurationMs: Number(scope.databaseDurationNs) / 1_000_000,
    unfinishedDatabaseRoundTripCount: scope.inFlightDatabaseRoundTripCount,
    ...(scope.taskId ? { taskId: scope.taskId } : {}),
  };
}
