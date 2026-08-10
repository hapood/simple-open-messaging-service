import { describe, expect, it } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { SystemMessageType } from '../message/system-message.js';
import { deriveLocalGroupSystemEvents } from './federation.service.js';

describe('deriveLocalGroupSystemEvents', () => {
  it('derives member, role, and owner notices from a committed roster diff', () => {
    expect(
      deriveLocalGroupSystemEvents(
        [
          { userId: 1, role: GroupRole.OWNER },
          { userId: 2, role: GroupRole.MEMBER },
          { userId: 3, role: GroupRole.ADMIN },
          { userId: 4, role: GroupRole.MEMBER },
        ],
        [
          { userId: 1, role: GroupRole.MEMBER },
          { userId: 2, role: GroupRole.ADMIN },
          { userId: 3, role: GroupRole.MEMBER },
          { userId: 5, role: GroupRole.OWNER },
        ],
        1,
        5,
      ),
    ).toEqual([
      {
        actorUserId: 5,
        subjectUserId: 2,
        type: SystemMessageType.GROUP_ADMIN_GRANTED,
      },
      {
        actorUserId: 5,
        subjectUserId: 3,
        type: SystemMessageType.GROUP_ADMIN_REVOKED,
      },
      {
        actorUserId: 5,
        subjectUserId: 5,
        type: SystemMessageType.GROUP_JOINED,
      },
      {
        actorUserId: 4,
        subjectUserId: 4,
        type: SystemMessageType.GROUP_LEFT,
      },
      {
        actorUserId: 5,
        subjectUserId: 5,
        type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
      },
    ]);
  });

  it('is idempotent when a repeated meta snapshot has no state difference', () => {
    const roster = [
      { userId: 1, role: GroupRole.OWNER },
      { userId: 2, role: GroupRole.MEMBER },
    ];
    expect(deriveLocalGroupSystemEvents(roster, roster, 1, 1)).toEqual([]);
  });
});
