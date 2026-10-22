import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { RESOURCE_ID_KEY } from '../common/resource-id.decorator.js';
import { BusinessCode } from '../common/business-code.js';
import { RelationshipController } from './relationship.controller.js';

/** Request-round commands and established-relationship commands use separate ports. */
function build(overrides: {
  requests?: unknown;
  userIntents?: unknown;
  userQuota?: unknown;
  memberIntents?: unknown;
}): RelationshipController {
  return new RelationshipController(
    (overrides.requests ?? {}) as never,
    (overrides.userIntents ?? {}) as never,
    (overrides.userQuota ?? {}) as never,
    (overrides.memberIntents ?? {}) as never,
  );
}

describe('RelationshipController.markRelationshipRequestsRead', () => {
  it('forwards the observed request ID without number conversion', async () => {
    const head = {
      requestEndId: '9007199254740993',
      requestReadId: '9007199254740993',
    };
    const requests = { markRead: vi.fn().mockResolvedValue(head) };
    const controller = build({ requests });
    await expect(
      controller.markRelationshipRequestsRead(
        { user: { userId: 7 } } as never,
        { requestReadId: head.requestReadId },
      ),
    ).resolves.toEqual(head);
    expect(requests.markRead).toHaveBeenCalledExactlyOnceWith(
      7,
      head.requestReadId,
    );
  });
});

describe('RelationshipController request-round boundary', () => {
  it.each([
    ['acceptRelationship', 'ACCEPT'],
    ['rejectRequest', 'REJECT'],
    ['withdrawRequest', 'WITHDRAW'],
  ] as const)(
    'routes %s by exact request ID, not address',
    async (method, decision) => {
      const outcome = { status: 'OK', threadId: 21 };
      const requests = {
        decidePersonal: vi.fn(),
        roundKind: vi.fn().mockResolvedValue('FRIEND'),
      };
      const userIntents = {
        execute: vi.fn(),
        decidePersonalRequest: vi.fn().mockResolvedValue(outcome),
      };
      const memberIntents = { executeByNamespace: vi.fn() };
      const controller = build({ requests, userIntents, memberIntents });
      await expect(
        controller[method]({ user: { userId: 7 } } as never, {
          requestId: '9007199254740993',
        }),
      ).resolves.toEqual(outcome);
      expect(userIntents.decidePersonalRequest).toHaveBeenCalledExactlyOnceWith(
        7,
        '9007199254740993',
        decision,
      );
      expect(requests.decidePersonal).not.toHaveBeenCalled();
      expect(userIntents.execute).not.toHaveBeenCalled();
      expect(memberIntents.executeByNamespace).not.toHaveBeenCalled();
    },
  );

  it('preserves stale and completed round outcomes', async () => {
    const userIntents = { decidePersonalRequest: vi.fn() };
    const requests = { roundKind: vi.fn().mockResolvedValue('FRIEND') };
    const controller = build({ requests, userIntents });
    for (const status of ['STALE_REQUEST', 'EXPIRED']) {
      userIntents.decidePersonalRequest.mockResolvedValueOnce({ status });
      await expect(
        controller.acceptRelationship({ user: { userId: 7 } } as never, {
          requestId: '42',
        }),
      ).resolves.toEqual({ status });
    }
  });
});

describe('RelationshipController.revokeRelationship', () => {
  it('retains the revoke route name with a threadId resource key', () => {
    const handler = RelationshipController.prototype.revokeRelationship;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('revoke');
    expect(Reflect.getMetadata(RESOURCE_ID_KEY, handler)).toBe('threadId');
  });
  it('ends an established relationship through the thread-keyed intent entry', async () => {
    const userIntents = {
      endEstablishedRelationship: vi
        .fn()
        .mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.revokeRelationship(
        { user: { userId: 7 }, threadAccess: { threadId: 12 } } as never,
        { threadId: 12 },
      ),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.endEstablishedRelationship).toHaveBeenCalledWith({
      userId: 7,
      threadId: 12,
    });
  });

  it('maps stale-revocation NOT_FOUND onto the public FRIEND_NOT_FOUND code', async () => {
    const userIntents = {
      endEstablishedRelationship: vi.fn().mockResolvedValue({
        status: 'REJECTED',
        reason: 'INTENT_NOT_FOUND',
        code: BusinessCode.NOT_FOUND,
        message: 'active relationship for thread [12] does not exist',
      }),
    };
    const controller = build({ userIntents });

    const result = await controller.revokeRelationship(
      { user: { userId: 7 }, threadAccess: { threadId: 12 } } as never,
      { threadId: 12 },
    );
    expect(result).toMatchObject({
      code: BusinessCode.FRIEND_NOT_FOUND,
      data: { status: 'REJECTED', reason: 'INTENT_NOT_FOUND' },
    });
  });
});

describe('RelationshipController.requestRelationship', () => {
  it('authors an exact local-group application with quota admission', async () => {
    const memberIntents = {
      executeByNamespace: vi.fn().mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({
      userQuota: { tick: vi.fn() },
      memberIntents,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: '!local-group',
        namespaceId: 0,
        snapshot: { displayName: 'Local Group', avatar: null },
        note: 'hello',
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(memberIntents.executeByNamespace).toHaveBeenCalledWith({
      memberUserId: 7,
      target: { account: '!local-group', namespaceId: 0 },
      snapshot: { displayName: 'Local Group', avatar: null },
      decision: 'REQUESTED',
      note: 'hello',
      admissionInTx: expect.any(Function),
    });
  });

  it('authors a remote-group application directly', async () => {
    const admissionTx = { admission: true };
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const memberIntents = {
      executeByNamespace: vi.fn().mockImplementation(async (params) => {
        await params.admissionInTx(admissionTx);
        return { status: 'APPLIED' };
      }),
    };
    const controller = build({
      userQuota,
      memberIntents,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: '!remote-group',
        namespaceId: 5,
        snapshot: { displayName: 'Remote Group', avatar: 'avatar' },
        note: 'let me in',
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(memberIntents.executeByNamespace).toHaveBeenCalledWith({
      memberUserId: 7,
      target: { account: '!remote-group', namespaceId: 5 },
      decision: 'REQUESTED',
      note: 'let me in',
      snapshot: { displayName: 'Remote Group', avatar: 'avatar' },
      admissionInTx: expect.any(Function),
    });
    expect(userQuota.tick).toHaveBeenCalledWith(7, 'requests', admissionTx);
  });

  it('runs the local request synchronously with in-transaction quota admission', async () => {
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const admissionTx = { admission: true };
    const userIntents = {
      execute: vi.fn().mockImplementation(async (_params, options) => {
        await options?.admissionInTx?.(admissionTx);
        return { status: 'APPLIED' };
      }),
    };
    const controller = build({ userIntents, userQuota });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        namespaceId: 0,
        note: 'hello',
        snapshot: { displayName: 'Bob', avatar: null },
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', namespaceId: 0 },
        note: 'hello',
        snapshot: { displayName: 'Bob', avatar: null },
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
    expect(userQuota.tick).toHaveBeenCalledWith(7, 'requests', admissionTx);
  });

  it('returns the active thread when the request collapses into acceptance', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'APPLIED',
        threadId: 33,
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        namespaceId: 0,
        snapshot: { displayName: 'Bob', avatar: null },
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 33 });
  });

  it('runs the federated request synchronously with in-transaction quota admission', async () => {
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const admissionTx = { admission: true };
    const userIntents = {
      execute: vi.fn().mockImplementation(async (_params, options) => {
        await options?.admissionInTx?.(admissionTx);
        return { status: 'APPLIED' };
      }),
    };
    const controller = build({
      userIntents,
      userQuota,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        namespaceId: 5,
        snapshot: { displayName: 'Bob', avatar: null },
        note: 'across servers',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', namespaceId: 5 },
        note: 'across servers',
        snapshot: { displayName: 'Bob', avatar: null },
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
    expect(userQuota.tick).toHaveBeenCalledWith(7, 'requests', admissionTx);
  });

  it('runs a federated request with an explicit no-avatar snapshot', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        namespaceId: 5,
        snapshot: { displayName: 'Bob', avatar: null },
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', namespaceId: 5 },
        note: '',
        snapshot: { displayName: 'Bob', avatar: null },
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
  });

  it('returns an unavailable actor as a business rejection', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'REJECTED',
        reason: 'ACTOR_NOT_FOUND',
        code: BusinessCode.UNAUTHENTICATED,
        message: 'authenticated user does not exist',
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        namespaceId: 5,
        snapshot: { displayName: 'Bob', avatar: null },
      }),
    ).resolves.toMatchObject({
      code: BusinessCode.UNAUTHENTICATED,
      data: { status: 'REJECTED', reason: 'ACTOR_NOT_FOUND' },
    });
  });

  it('forwards the namespace id from the DTO to the intent service', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ status: 'APPLIED', threadId: 42 }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        namespaceId: 5,
        snapshot: { displayName: 'Bob', avatar: null },
        note: 'nsid-first',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 42 });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', namespaceId: 5 },
        note: 'nsid-first',
        snapshot: { displayName: 'Bob', avatar: null },
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
  });

  it.each([
    {
      name: 'missing target',
      reason: 'TARGET_NOT_FOUND',
      expectedCode: BusinessCode.NOT_FOUND,
    },
    {
      name: 'self target',
      reason: 'SELF_TARGET',
      expectedCode: BusinessCode.FRIEND_SELF,
    },
  ])(
    'serializes $name returned by the intent service',
    async ({ reason, expectedCode }) => {
      const userIntents = {
        execute: vi.fn().mockResolvedValue({
          status: 'REJECTED',
          reason,
          code: expectedCode,
          message: 'business rejection',
        }),
      };
      const controller = build({ userIntents });

      await expect(
        controller.requestRelationship({ user: { userId: 7 } } as never, {
          account: reason === 'SELF_TARGET' ? 'alice' : 'bob',
          namespaceId: 0,
          snapshot: { displayName: 'Target', avatar: null },
        }),
      ).resolves.toMatchObject({
        code: expectedCode,
        data: { status: 'REJECTED', reason },
      });
    },
  );
});
