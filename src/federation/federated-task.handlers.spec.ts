import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import {
  AcceptAddressedRelationshipRequestTaskHandler,
  RevokeAddressedRelationshipRequestTaskHandler,
  SendFederatedRelationshipRequestTaskHandler,
} from './federated-relationship-request-task.handlers.js';
import {
  AcceptAddressedGroupInvitationTaskHandler,
  RequestFederatedGroupJoinTaskHandler,
  RevokeFederatedGroupJoinTaskHandler,
} from './federated-group-task.handlers.js';

function task(
  scopeType: 'USER_PAIR' | 'GROUP',
  payload: Record<string, unknown>,
): DurableTask {
  return {
    id: 1n,
    parentTaskId: null,
    kind: 'MUTATION',
    scopeType,
    scopeKey: 'scope',
    taskType: 'TEST',
    actorUserId: 7,
    payload,
    checkpoint: {},
    coalescingKey: null,
    supersededByTaskId: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('federated task handlers', () => {
  const dispatcher = { register: vi.fn() };

  it('dispatches addressed friend tasks with normalized persisted input', async () => {
    const execution = {
      send: vi.fn().mockResolvedValue(undefined),
      accept: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
    await new SendFederatedRelationshipRequestTaskHandler(
      dispatcher as never,
      execution as never,
    ).execute(
      task('USER_PAIR', {
        account: 'bob',
        domain: 'peer.test',
        note: 'hello',
        displayName: 'Bob',
      }),
    );
    await new AcceptAddressedRelationshipRequestTaskHandler(
      dispatcher as never,
      execution as never,
    ).execute(task('USER_PAIR', { account: 'bob', domain: 'peer.test' }));
    await new RevokeAddressedRelationshipRequestTaskHandler(
      dispatcher as never,
      execution as never,
    ).execute(task('USER_PAIR', { account: 'bob', domain: 'peer.test' }));

    expect(execution.send).toHaveBeenCalledWith({
      actorUserId: 7,
      account: 'bob',
      domain: 'peer.test',
      note: 'hello',
      displayName: 'Bob',
    });
    expect(execution.accept).toHaveBeenCalledWith({
      actorUserId: 7,
      account: 'bob',
      domain: 'peer.test',
    });
    expect(execution.revoke).toHaveBeenCalledWith({
      actorUserId: 7,
      account: 'bob',
      domain: 'peer.test',
    });
  });

  it('dispatches federated group request, revoke, and acceptance tasks', async () => {
    const execution = {
      request: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
      accept: vi.fn().mockResolvedValue(undefined),
    };
    await new RequestFederatedGroupJoinTaskHandler(
      dispatcher as never,
      execution as never,
    ).execute(
      task('GROUP', {
        account: '!group',
        domain: 'peer.test',
        note: 'join',
        displayName: 'Group',
      }),
    );
    await new RevokeFederatedGroupJoinTaskHandler(
      dispatcher as never,
      execution as never,
    ).execute(task('GROUP', { account: '!group', domain: 'peer.test' }));
    await new AcceptAddressedGroupInvitationTaskHandler(
      dispatcher as never,
      execution as never,
    ).execute(task('GROUP', { account: '!group', domain: 'peer.test' }));

    expect(execution.request).toHaveBeenCalledWith({
      actorUserId: 7,
      account: '!group',
      domain: 'peer.test',
      note: 'join',
      displayName: 'Group',
    });
    expect(execution.revoke).toHaveBeenCalled();
    expect(execution.accept).toHaveBeenCalled();
  });
});
