import { SetMetadata } from '@nestjs/common';
import { GroupRole } from '../prisma/generated/client.js';

/** Metadata key carrying the set of roles allowed on a route (read by RolesGuard). */
export const ROLES_KEY = 'group:roles';

/**
 * Restrict a group route to the given roles. Requires GroupAccessGuard to have run first — it
 * loads the caller's ThreadParticipant and attaches it to `req.groupAccess`. RolesGuard then
 * checks `participant.role` against this set.
 *
 * Usage: `@UseGuards(JwtAuthGuard, GroupAccessGuard, RolesGuard)` + `@Roles(GroupRole.OWNER)`.
 */
export const Roles = (...roles: GroupRole[]) => SetMetadata(ROLES_KEY, roles);
