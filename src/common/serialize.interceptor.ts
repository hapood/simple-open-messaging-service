import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { BusinessCode } from './business-code.js';
import { API_ENVELOPE, isApiEnvelope, type ApiEnvelope } from './api-result.js';
import { IS_RAW } from './raw.decorator.js';

/**
 * Recursively serializes the response body: `BigInt → string`, `Date → millisecond timestamp (number)`.
 *
 * Takes over and replaces two historical hacks:
 *  - the former `Date.prototype.toJSON` global override in `main.ts` (process-level side effect, removed);
 *  - the former `convertBigIntId` (only converted the top-level `id` and returned void, missing nested fields like `lastRead`).
 *
 * Returns the converted plain object — BigInt/Date have become primitives,
 * so the subsequent NestJS/Express `res.json` will no longer throw `Do not know how to serialize a BigInt`.
 */
// Public serializer: preserves the input's static type. BigInt/Date conversion is a runtime transform
// only — the property shape is unchanged — so the generic `<T>(value: T): T` lets callers receive a
// typed result (e.g. the SSE/push `msgData`) instead of `unknown`. The recursive walk lives in
// serializeImpl (returns `unknown`); a single boundary cast reconciles the two.
export function serializeBody<T>(value: T): T {
  return serializeImpl(value, new WeakSet<object>()) as T;
}

function serializeImpl(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value !== 'object') {
    return value; // number/string/boolean/symbol returned as-is
  }

  // Circular reference defense (Prisma data is acyclic, purely defensive): already-seen objects return the original reference to avoid stack overflow.
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => serializeImpl(item, seen));
  }

  // Only traverse "plain objects"; class instances / Map / Set / Buffer / TypedArray etc. are returned as-is,
  // to avoid mishandling container types beyond Prisma.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = serializeImpl((value as Record<string, unknown>)[key], seen);
  }
  return result;
}

/**
 * Build the `ApiResult` envelope for a handler's raw return value:
 *  - an `envelope()` carrier → unwrapped to `{ code: 0, message: 'successful', data, messageKey?, hasMore? }`;
 *  - a pre-built envelope (a legacy `{ code, message, data }` literal) → passed through verbatim (compat);
 *  - anything else (raw `data`) → wrapped as `{ code: 0, message: 'successful', data }`.
 *
 * The compat branch lets handlers migrate from hand-built literals to raw-`data` returns incrementally with
 * no wire change; it is removed once every handler returns raw data. The carrier branch serves the few
 * endpoints whose data alone does not carry `messageKey` / `hasMore`.
 */
function envelopeFor(data: unknown): unknown {
  // A void/null return (e.g. a handler that sent via @Res or has no payload) is passed through unwrapped —
  // wrapping it would change the wire body for those routes, which Phase A forbids (wire-identical).
  if (data === undefined || data === null) return data;
  if (isApiEnvelope(data)) {
    const carrier = data as ApiEnvelope;
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: carrier.data,
      messageKey: carrier.messageKey,
      hasMore: carrier.hasMore,
    };
  }
  if (isPreBuiltEnvelope(data)) return data;
  return { code: BusinessCode.OK, message: 'successful', data };
}

/** Compat detector: a handler-returned object that is ALREADY an `{ code, message, … }` envelope. */
function isPreBuiltEnvelope(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { code?: unknown }).code === 'number' &&
    typeof (data as { message?: unknown }).message === 'string'
  );
}

// Keep the unused `API_ENVELOPE` import off the dead-code list — it documents that the carrier brand lives in
// api-result.ts (the `Symbol` is read transitively via `isApiEnvelope`, which a bundler may not see).
void API_ENVELOPE;

/**
 * Global response interceptor. For each response:
 *  1. if the handler/controller is `@Raw()`, serialize its raw return as-is (no envelope);
 *  2. otherwise wrap (or pass through / unwrap per {@link envelopeFor}), then run {@link serializeBody}.
 *
 * Registered in `src/bootstrap.ts` via `useGlobalInterceptors`. (The exception filter bypasses the interceptor
 * chain, but its response body contains only `{ code, message, data }` primitives, so no conversion is needed.)
 */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(IS_RAW, [
      context.getHandler(),
      context.getClass(),
    ]);
    return next.handle().pipe(
      map((data) => serializeBody(isRaw ? data : envelopeFor(data))),
    );
  }
}
