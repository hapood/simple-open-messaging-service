import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupAuthoredMembershipIntentService } from './group-authored-membership-intent.service.js';
import { captureGroupDepartureUpdatesInTx } from '../../shared/capture-group-departure-updates.js';

vi.mock('../../shared/capture-group-departure-updates.js', () => ({
  captureGroupDepartureUpdatesInTx: vi.fn().mockResolvedValue([
    {
      kind: 'group-request-read',
      userId: 2,
      feedId: 90,
      threadFeedEndId: 7,
    },
  ]),
}));
vi.mock('../shared/group-membership-revocation-sql.js', () => ({
  groupMembershipRevocationIntentWrite: () => ({}),
  groupMembershipRevocationSql: () => ({}),
}));

describe('group-authored departure request convergence', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([false, true])(
    'captures only an actual departed local member (pairChanged=%s)',
    async (pairChanged) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [{ pairChanged }] }),
      };
      const service = Object.create(
        GroupAuthoredMembershipIntentService.prototype,
      ) as GroupAuthoredMembershipIntentService;
      Object.assign(service, {
        relationshipMutations: {
          writeMemberRelationshipIntentInTx: vi
            .fn()
            .mockResolvedValue(new Map()),
        },
      });
      const updates: unknown[] = [];
      await (service as any).applyRevocationInTx(
        {
          tx,
          input: {},
          action: 'KICK',
          localMemberId: 2,
          params: { threadId: 10 },
          member: { namespaceId: 0 },
        },
        updates,
      );
      if (pairChanged) {
        expect(
          captureGroupDepartureUpdatesInTx,
        ).toHaveBeenCalledExactlyOnceWith(tx, 10, 2);
        expect(updates).toEqual([
          expect.objectContaining({ kind: 'group-request-read' }),
        ]);
      } else {
        expect(captureGroupDepartureUpdatesInTx).not.toHaveBeenCalled();
        expect(updates).toEqual([]);
      }
    },
  );
});
