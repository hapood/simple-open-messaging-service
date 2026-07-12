import { SetMetadata } from '@nestjs/common';
import { GroupRole } from '../prisma/generated/client.js';

/** Metadata key carrying the set of roles allowed on a route (read by RolesGuard). */
export const ROLES_KEY = 'group:roles';

/**
 * Restrict a group route to the given roles. Requires ThreadAccessGuard to have run first — it
 * loads the caller's ThreadParticipant and attaches it to `req.threadAccess`. RolesGuard then
 * checks `participant.role` against this set.
 *
 * Usage: `@UseGuards(ThreadAccessGuard, RolesGuard)` + `@Roles(GroupRole.OWNER)` (JWT auth is global).
 */
export const Roles = (...roles: GroupRole[]) => SetMetadata(ROLES_KEY, roles);
