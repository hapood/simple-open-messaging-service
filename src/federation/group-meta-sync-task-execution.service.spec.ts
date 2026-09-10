import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { GroupMetaSyncTaskExecutionService } from './group-meta-sync-task-execution.service.js';

const task = {
  id: 4n,
  kind: 'PROJECTION',
  scopeType: 'GROUP',
  scopeKey: 'group:8',
  taskType: 'SYNC_GROUP_META',
  actorUserId: null,
  payload: {
    groupId: 8,
    groupAccount: '!group',
    peerDomain: 'peer.test',
    namespaceId: 3,
    through: '20',
  },
  checkpoint: {
    phase: 'PULL',
    mode: 'delta',
    after: '10',
    through: '20',
  },
  coalescingKey: 'group-meta',
  status: 'ASYNC_PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

interface ExecutionInternals {
  readCurrent: ReturnType<typeof vi.fn>;
  beginFullRecovery: ReturnType<typeof vi.fn>;
  applyPage: ReturnType<typeof vi.fn>;
  cleanupFullMembers: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
}

function harness() {
  const fetchPage = vi.fn();
  const service = new GroupMetaSyncTaskExecutionService(
    {} as never,
    {
      fetchPage,
    } as never,
    {} as never,
    {} as never,
  );
  const internals: ExecutionInternals = {
    readCurrent: vi.fn(),
    beginFullRecovery: vi.fn().mockResolvedValue(undefined),
    applyPage: vi.fn().mockResolvedValue(undefined),
    cleanupFullMembers: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
  };
  Object.assign(service as unknown as ExecutionInternals, internals);
  return { service, fetchPage, ...internals };
}

describe('GroupMetaSyncTaskExecutionService', () => {
  it('fetches and commits one page before reading the persisted next phase', async () => {
    const page = {
      account: '!group',
      mode: 'delta',
      items: [],
      scannedThrough: '20',
      groupMetaFeedEndId: '20',
      hasMore: false,
    };
    const { service, fetchPage, readCurrent, applyPage, finalize } = harness();
    fetchPage.mockResolvedValue(page);
    readCurrent.mockResolvedValueOnce(task).mockResolvedValueOnce({
      ...task,
      checkpoint: { phase: 'FINALIZE', mode: 'delta', through: '20' },
    });

    await service.execute(task);

    expect(fetchPage).toHaveBeenCalledWith('peer.test', {
      account: '!group',
      mode: 'delta',
      after: 10n,
      through: 20n,
    });
    expect(applyPage).toHaveBeenCalledWith(
      task.id,
      task.payload,
      task.checkpoint,
      page,
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(readCurrent).toHaveBeenCalledTimes(2);
  });

  it('persists full recovery coordinates after a delta cursor gap', async () => {
    const { service, fetchPage, readCurrent, beginFullRecovery, finalize } =
      harness();
    const recovery = new RemoteFeedCursorUnavailableError(2n, 25n);
    fetchPage.mockRejectedValue(recovery);
    readCurrent.mockResolvedValueOnce(task).mockResolvedValueOnce({
      ...task,
      checkpoint: { phase: 'FINALIZE', mode: 'full', through: '24' },
    });

    await service.execute(task);

    expect(beginFullRecovery).toHaveBeenCalledWith(
      task.id,
      task.payload,
      task.checkpoint,
      recovery,
    );
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('runs repeated cleanup transactions until the checkpoint advances', async () => {
    const cleanupCheckpoint = {
      phase: 'CLEANUP_MEMBERS' as const,
      mode: 'full' as const,
      through: '20',
    };
    const { service, readCurrent, cleanupFullMembers, finalize } = harness();
    readCurrent
      .mockResolvedValueOnce({ ...task, checkpoint: cleanupCheckpoint })
      .mockResolvedValueOnce({ ...task, checkpoint: cleanupCheckpoint })
      .mockResolvedValueOnce({
        ...task,
        checkpoint: { phase: 'FINALIZE', mode: 'full', through: '20' },
      });

    await service.execute(task);

    expect(cleanupFullMembers).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledOnce();
  });
});
