import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key marking a controller or handler as returning a NON-envelope payload. The global
 * `SerializeInterceptor` reads it via `Reflector.getAllAndOverride(IS_RAW, [handler, class])` and skips
 * envelope-wrapping for that route (it still runs `serializeBody` — BigInt/Date conversion — on the raw
 * return). Mirrors the `@Public()` / `IS_PUBLIC` opt-out convention.
 *
 * Apply at CLASS level when every method is non-envelope (the S2S federation controllers, `.well-known`);
 * at METHOD level for a mixed controller (a shell/diagnostics/log handler that streams bytes alongside
 * enveloped siblings). Handlers that already bypass the interceptor via `reply.hijack()` / `@Res()`
 * (non-passthrough) are auto-skipped by Nest, but marking them `@Raw()` makes the intent explicit and guards
 * against the auto-skip behavior changing.
 */
export const IS_RAW = 'isRaw';

/** Mark a controller or handler as raw — its return value is NOT wrapped in the `ApiResult` envelope. */
export const Raw = () => SetMetadata(IS_RAW, true);
