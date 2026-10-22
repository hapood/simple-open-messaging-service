import {
  GroupRole,
  type GroupRole as GroupRoleValue,
} from '../../database/enums.js';

interface GroupManagerProjectionHead<T> {
  applicationEndId: T;
  invitationEndId: T;
}

/** Manager capability is shared by owners and administrators. Keeping this
 * predicate here prevents role writers from giving OWNER a separate, subtly
 * different join-request projection. */
export function isGroupManagerRole(
  role: GroupRoleValue | null | undefined,
): boolean {
  return role === GroupRole.OWNER || role === GroupRole.ADMIN;
}

/** Complete manager-capability state for a newly created or reactivated local
 * participant projection. A new manager starts at the current head so old
 * requests are not presented as newly unread. */
export function initialGroupManagerProjection<T>(
  role: GroupRoleValue,
  head: GroupManagerProjectionHead<T>,
) {
  return isGroupManagerRole(role)
    ? {
        joinRequestEndFeedId: head.applicationEndId,
        joinRequestReadFeedId: head.applicationEndId,
        groupInviteEndFeedId: head.invitationEndId,
      }
    : {
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
      };
}

/** Manager-capability delta for an existing participant. ADMIN and OWNER have
 * the same capability, so transitions between them deliberately preserve all
 * request watermarks. */
export function transitionGroupManagerProjection<T>(
  previousRole: GroupRoleValue | null,
  nextRole: GroupRoleValue,
  head: GroupManagerProjectionHead<T>,
) {
  if (
    previousRole !== null &&
    isGroupManagerRole(previousRole) === isGroupManagerRole(nextRole)
  )
    return {};
  return initialGroupManagerProjection(nextRole, head);
}
