import type { PoolClient } from 'pg';
import { beginDatabaseRoundTrip } from '../diagnostics/execution-measurement.js';

const instrumented = Symbol('database execution measurement installed');

type InstrumentedPoolClient = PoolClient & { [instrumented]?: true };
type QueryCallback = (...args: unknown[]) => unknown;
type QueryEventSource = {
  once(event: 'end' | 'error', listener: (error?: unknown) => void): unknown;
};

/** Instruments the driver's query boundary once per physical pooled client. */
export function instrumentDatabaseClient(client: PoolClient): void {
  const target = client as InstrumentedPoolClient;
  if (target[instrumented]) return;
  target[instrumented] = true;

  const originalQuery = client.query.bind(client) as (
    ...args: unknown[]
  ) => unknown;
  client.query = ((...args: unknown[]) => {
    const finishRoundTrip = beginDatabaseRoundTrip();
    if (!finishRoundTrip) return originalQuery(...args);

    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      finishRoundTrip(error);
    };
    const callback = args.at(-1);
    const callArgs = [...args];
    if (typeof callback === 'function') {
      callArgs[callArgs.length - 1] = (...callbackArgs: unknown[]) => {
        finish(callbackArgs[0]);
        return Reflect.apply(
          callback as QueryCallback,
          undefined,
          callbackArgs,
        );
      };
    }

    let result: unknown;
    try {
      result = originalQuery(...callArgs);
    } catch (error) {
      finish(error);
      throw error;
    }

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (value) => {
          finish();
          return value;
        },
        (error: unknown) => {
          finish(error);
          throw error;
        },
      );
    }
    if (isQueryEventSource(result)) {
      result.once('end', () => finish());
      result.once('error', (error?: unknown) => finish(error));
    } else if (typeof callback !== 'function') {
      finish();
    }
    return result;
  }) as typeof client.query;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function isQueryEventSource(value: unknown): value is QueryEventSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    'once' in value &&
    typeof value.once === 'function'
  );
}
