import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '../database/enums.js';

/** Metadata key carrying the admin roles allowed on a route (read by AdminRolesGuard). */
export const ADMIN_ROLES_KEY = 'admin:roles';

/**
 * Restrict an admin route to the given roles. Requires AdminAuthGuard to have run first — it
 * authenticates the admin and attaches `role` to `req.user`. AdminRolesGuard
 * then checks `req.user.role` against this set.
 *
 * Usage: `@UseGuards(AdminAuthGuard, AdminRolesGuard)` + `@Roles(AdminRole.SUPER_ADMIN)`.
 * Routes with no @Roles pass through — list/view endpoints stay open to every admin role.
 */
export const Roles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
