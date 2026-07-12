/**
 * GroupAccessGuard was ABOLISHED (2026-07): groups are now `!`-User threads, so group-route
 * membership is identical to thread membership and is enforced by ThreadAccessGuard
 * (src/thread-participant/thread-access.guard.ts). Group routes use
 * `@UseGuards(ThreadAccessGuard[, RolesGuard])` + `@ResourceId<Dto>('groupId')` (JWT auth is global)
 * (the `groupId` body value is the threadId). This file intentionally has no exports.
 */
export {};
