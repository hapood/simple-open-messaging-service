import { describe, expect, it, vi } from 'vitest';
import { ProfileLookup } from './profile-resolution-demand.js';
import { ProfileEvidenceProjectionService } from './profile-evidence-projection.service.js';

function createSubject() {
  const database = {
    db: {
      transaction: vi.fn(async (work) => work({ execute: vi.fn() })),
    },
  };
  const sse = { onThreadFeedUpdated: vi.fn() };
  const subject = new ProfileEvidenceProjectionService(
    database as never,
    sse as never,
  );
  return { subject, database, sse };
}

const accountProjection = {
  profile: { namespaceId: 7, account: 'alice', domain: 'member.test', rev: 4 },
  lookup: ProfileLookup.ACCOUNT_PROFILE,
  projection: { threadId: 9, messageSeq: 6 },
} as const;

function mockSuccessfulP2PProjection(database: ReturnType<typeof createSubject>['database']) {
  database.db.transaction.mockImplementation(async (work) => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            type: 'P2P',
            groupId: null,
            account: null,
            domain: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [{ accountId: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ accountId: 3, threadFeedId: 12 }] });
    return work({ execute });
  });
}

describe('ProfileEvidenceProjectionService', () => {
  it('runs evidence projection through its own queue and LRU', async () => {
    const { subject, database, sse } = createSubject();
    mockSuccessfulP2PProjection(database);

    await subject.resolve(accountProjection);
    await vi.waitFor(() => expect(subject['pending'].size).toBe(0));
    await subject.resolve(accountProjection);

    expect(database.db.transaction).toHaveBeenCalledOnce();
    expect(subject['cache'].size).toBe(1);
    expect(sse.onThreadFeedUpdated).toHaveBeenCalledWith(3, {
      threadFeedEndId: 12,
      notificationRelevant: false,
    });
  });

  it('uses the LRU as a max evidence-value hint for message-landed updates', async () => {
    const { subject, database } = createSubject();
    mockSuccessfulP2PProjection(database);

    await subject.resolve(accountProjection);
    await vi.waitFor(() => expect(subject['pending'].size).toBe(0));
    await subject.resolve({
      ...accountProjection,
      profile: { ...accountProjection.profile, rev: 5 },
      projection: { threadId: 9, messageSeq: 5 },
    });
    await subject.resolve({
      ...accountProjection,
      profile: { ...accountProjection.profile, rev: 6 },
      projection: { threadId: 9, messageSeq: 7 },
    });
    await vi.waitFor(() => expect(database.db.transaction).toHaveBeenCalledTimes(2));

    expect([...subject['cache'].values()]).toEqual([7]);
  });

  it('coalesces active evidence by slot into one trailing greatest message seq', async () => {
    const { subject, database } = createSubject();
    let release!: () => void;
    database.db.transaction.mockImplementation(
      () => new Promise<[]>((resolve) => (release = () => resolve([]))),
    );

    await subject.resolve(accountProjection);
    await vi.waitFor(() => expect(subject['pending'].size).toBe(1));
    await subject.resolve({
      ...accountProjection,
      profile: { ...accountProjection.profile, rev: 5 },
      projection: { threadId: 9, messageSeq: 8 },
    });

    const pending = [...subject['pending'].values()][0]!;
    expect(subject['pending'].size).toBe(1);
    expect(pending.projection.projection.messageSeq).toBe(6);
    expect(pending.trailing?.projection.messageSeq).toBe(8);
    mockSuccessfulP2PProjection(database);
    release!();
    await vi.waitFor(() => expect(subject['pending'].size).toBe(0));
    expect(database.db.transaction).toHaveBeenCalledTimes(2);
    expect([...subject['cache'].values()]).toEqual([8]);
  });

  it('does not advance the LRU on a no-op projection and replays later evidence', async () => {
    const { subject, database } = createSubject();
    database.db.transaction
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ accountId: 3, threadFeedId: 12 }]);

    await subject.resolve(accountProjection);
    await vi.waitFor(() => expect(subject['pending'].size).toBe(0));
    expect(subject['cache'].size).toBe(0);

    await subject.resolve({
      ...accountProjection,
      profile: { ...accountProjection.profile, rev: 5 },
      projection: { threadId: 9, messageSeq: 7 },
    });
    await vi.waitFor(() => expect(subject['pending'].size).toBe(0));

    expect(database.db.transaction).toHaveBeenCalledTimes(2);
    expect([...subject['cache'].values()]).toEqual([7]);
  });

  it('skips new evidence slots with a warning when all slots are pending', async () => {
    const { subject, database } = createSubject();
    const warn = vi
      .spyOn(subject['logger'], 'warn')
      .mockImplementation(() => undefined);
    subject['pending'].set('full', {
      projection: accountProjection,
      state: 'QUEUED',
    });
    vi.spyOn(subject['pending'], 'size', 'get').mockReturnValue(1000);

    await subject.resolve({
      ...accountProjection,
      profile: { ...accountProjection.profile, account: 'bob' },
    });

    expect(database.db.transaction).not.toHaveBeenCalled();
    expect(subject['pending'].size).toBe(1000);
    expect(warn).toHaveBeenCalledWith(
      'profile evidence projection queue is full; skipping evidence update',
    );
  });

  it('does not throw or retry through profile resolution when projection fails', async () => {
    const { subject, database, sse } = createSubject();
    database.db.transaction.mockRejectedValue(new Error('projection failed'));

    await expect(subject.resolve(accountProjection)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(database.db.transaction).toHaveBeenCalledOnce());

    expect(subject['pending'].size).toBe(0);
    expect(subject['cache'].size).toBe(0);
    expect(sse.onThreadFeedUpdated).not.toHaveBeenCalled();
  });
});
