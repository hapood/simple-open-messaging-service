import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { RevokeGroupRelationshipTaskHandler } from './revoke-group-relationship-task.handler.js';

describe('group-authored revocation', () => {
  it.each(['KICK', 'REJECT_REQUEST', 'REVOKE_INVITATION'])(
    'preserves the existing %s authorization and mutation branch',
    async (operation) => {
      const groups = {
        kickMember: vi.fn(),
        handleJoinRequest: vi.fn(),
        revokeInvitation: vi.fn(),
      };
      const handler = new RevokeGroupRelationshipTaskHandler(
        {} as never,
        groups as never,
      );
      await handler.execute({
        kind: 'MUTATION',
        scopeType: 'GROUP',
        actorUserId: 3,
        payload: {
          threadId: 10,
          targetUserId: 7,
          memberUserId: 7,
          requestId: '12',
          operation,
        },
      } as DurableTask);
      if (operation === 'KICK')
        expect(groups.kickMember).toHaveBeenCalledExactlyOnceWith({
          threadId: 10,
          operatorUserId: 3,
          targetUserId: 7,
        });
      else if (operation === 'REJECT_REQUEST')
        expect(groups.handleJoinRequest).toHaveBeenCalledExactlyOnceWith({
          threadId: 10,
          requestId: 12n,
          managerUserId: 3,
          decision: 'REVOKED',
        });
      else
        expect(groups.revokeInvitation).toHaveBeenCalledExactlyOnceWith({
          threadId: 10,
          requestId: 12n,
          managerUserId: 3,
        });
      expect(
        Object.values(groups).reduce((n, fn) => n + fn.mock.calls.length, 0),
      ).toBe(1);
    },
  );
});
