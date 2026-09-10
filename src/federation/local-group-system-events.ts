import { GroupRole } from '../database/enums.js';
import { SystemMessageType } from '../message/system-message.js';

export type LocalGroupSystemEvent =
  import('../message/system-message.js').SystemMessageInput;

/** Pure roster diff used only to decorate the local timeline after GROUP_META commits. */
export function deriveLocalGroupSystemEvents(
  before: ReadonlyArray<{ userId: number; role: GroupRole | null }>,
  after: ReadonlyArray<{ userId: number; role: GroupRole }>,
  previousOwnerId: number,
  nextOwnerId: number,
): LocalGroupSystemEvent[] {
  const previousRoles = new Map(before.map((row) => [row.userId, row.role]));
  const nextIds = new Set(after.map((row) => row.userId));
  const events: LocalGroupSystemEvent[] = [];
  for (const { userId, role } of after) {
    const previousRole = previousRoles.get(userId);
    if (previousRole === undefined) {
      events.push({
        member: userId,
        type: SystemMessageType.GROUP_JOINED,
      });
    } else if (role === GroupRole.ADMIN && previousRole === GroupRole.MEMBER) {
      events.push({
        member: userId,
        type: SystemMessageType.GROUP_ADMIN_GRANTED,
      });
    } else if (role === GroupRole.MEMBER && previousRole === GroupRole.ADMIN) {
      events.push({
        member: userId,
        type: SystemMessageType.GROUP_ADMIN_REVOKED,
      });
    }
  }
  for (const { userId } of before) {
    if (!nextIds.has(userId)) {
      events.push({
        member: userId,
        type: SystemMessageType.GROUP_LEFT,
      });
    }
  }
  if (previousOwnerId !== nextOwnerId) {
    events.push({
      previousOwner: previousOwnerId,
      newOwner: nextOwnerId,
      type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
    });
  }
  return events;
}
