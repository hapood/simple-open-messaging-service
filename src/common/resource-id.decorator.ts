import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key holding the body field (a `keyof Dto`) that an access guard authorizes against — the
 * resource id the membership lookup keys on.
 */
export const RESOURCE_ID_KEY = 'access:resourceIdField';

/**
 * Declare the body field carrying the resource id an access guard authorizes against. Read by
 * `ThreadAccessGuard` / `GroupAccessGuard` via Reflector.
 *
 * The field is typed as `keyof Dto`, so renaming it is a compile error at every route that declares
 * it — never a silent runtime drift from a string the guard itself guessed (the original motivation:
 * a guard hard-coding `'threadId'` would keep compiling after a DTO rename and silently read
 * `undefined`). This is the same Reflector + decorator pattern `RolesGuard` uses for `@Roles(...)`,
 * the codebase's established authorization convention.
 *
 * Usage: `@ResourceId<MarkReadDto>('threadId')` alongside `@UseGuards(..., ThreadAccessGuard)`.
 */
export const ResourceId =
  <T extends object>(field: keyof T) =>
    SetMetadata(RESOURCE_ID_KEY, field);
