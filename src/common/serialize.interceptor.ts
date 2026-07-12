import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

/**
 * 递归序列化响应体：`BigInt → string`、`Date → 毫秒时间戳(number)`。
 *
 * 接管并替代两处历史 hack：
 *  - 原 `main.ts` 的 `Date.prototype.toJSON` 全局覆盖（进程级副作用，已移除）；
 *  - 原 `convertBigIntId`（只转顶层 `id` 且返回 void，漏嵌套字段如 `lastRead`）。
 *
 * 返回的是已转换的 plain object —— BigInt/Date 均已变成原语，
 * 后续 NestJS/Express 的 `res.json` 不会再因 BigInt 抛 `Do not know how to serialize a BigInt`。
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
    return value; // number/string/boolean/symbol 原样
  }

  // 循环引用防御（Prisma 数据无环，纯防御）：已见对象返回原引用，避免爆栈。
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => serializeImpl(item, seen));
  }

  // 仅遍历「普通对象」(plain object)；类实例 / Map / Set / Buffer / TypedArray 等原样返回，
  // 避免误处理 Prisma 之外的容器类型。
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
 * 全局响应序列化拦截器：对每个 HTTP 响应体套 `serializeBody`。
 * 与 ValidationPipe / AllExceptionsFilter 一样在 `main.ts` 经 `useGlobalInterceptors` 注册。
 * （异常过滤器不经拦截器链，但其响应体只含 { code, message } 原语，无需转换。）
 */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serializeBody(data)));
  }
}
