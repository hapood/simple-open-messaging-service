import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key marking a route as exempt from the global {@link SessionAuthGuard}. Read by the guard via
 * `Reflector.getAllAndOverride(IS_PUBLIC, [handler, class])`, so a controller-level `@Public()` covers
 * every method on it (the handler scan finds nothing, then the class scan returns `true`).
 *
 * Secure-by-default auth model: a route is authenticated unless it carries `@Public()`. This is the
 * standard NestJS escape hatch (global APP_GUARD + IS_PUBLIC), mirroring the `@ResourceId` / `@Roles`
 * Reflector-decorator convention already in this codebase.
 */
export const IS_PUBLIC = 'isPublic';

/**
 * Mark a controller or handler as public — the global `SessionAuthGuard` (registered as APP_GUARD in
 * AuthModule) short-circuits to `true` without inspecting the bearer token. Use on login/register/health
 * and on routes authenticated by a *different* mechanism (admin JWT, s2s HTTP signature, notification
 * token) so the user-JWT guard does not reject them before their own guard runs.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
