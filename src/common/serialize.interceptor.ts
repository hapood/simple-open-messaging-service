import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

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
 * Global response serialization interceptor: wraps every HTTP response body with `serializeBody`.
 * Registered in `main.ts` via `useGlobalInterceptors`, like ValidationPipe / AllExceptionsFilter.
 * (The exception filter bypasses the interceptor chain, but its response body contains only { code, message } primitives, so no conversion is needed.)
 */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serializeBody(data)));
  }
}
