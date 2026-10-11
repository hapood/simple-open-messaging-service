import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueCurrentThreadFanoutsInTx } = vi.hoisted(() => ({
  enqueueCurrentThreadFanoutsInTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../message/thread-fanout-task.js', () => ({
  enqueueCurrentThreadFanoutsInTx,
}));

import { publishMemberMessageProfileInTx } from './publish-member-message-profile-in-tx.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    threadLock: { tx: undefined, threadId: 9 } as never,
    account: 'charlie',
    publisherNamespaceId: 7,
    namespaceId: 12,
    messageSeq: 24,
    profileRev: 6,
    ...overrides,
  };
}

function transaction() {
  return {
    execute: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ metaEndId: 40 }] })
      .mockResolvedValueOnce({
        rows: [{ profileRev: 5, profileSourceSeq: null }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }),
  };
}

function sqlText(query: unknown): string {
  return new PgDialect().sqlToQuery(query as never).sql;
}

describe('publishMemberMessageProfileInTx', () => {
  beforeEach(() => enqueueCurrentThreadFanoutsInTx.mockClear());

  it('pins the member evidence to the origin group and member relationship', async () => {
    const tx = transaction();
    await expect(
      publishMemberMessageProfileInTx(tx as never, candidate()),
    ).resolves.toBe(true);

    const feedQuery = sqlText(tx.execute.mock.calls[0]![0]);
    const memberQuery = sqlText(tx.execute.mock.calls[1]![0]);
    const evidenceQuery = sqlText(tx.execute.mock.calls[2]![0]);
    expect(feedQuery).toContain('thread."authorityNamespaceId" = 0');
    expect(memberQuery).toContain('pair.active');
    expect(memberQuery).toContain('pair."endpointBNamespaceId"');
    expect(memberQuery).not.toContain('pair.established');
    expect(evidenceQuery).toContain('m."publisherNamespaceId"');
    expect(evidenceQuery).toContain('p."publisherNamespaceId"');
    expect(enqueueCurrentThreadFanoutsInTx).toHaveBeenCalledOnce();
  });

  it('rejects evidence from before the member joined this incarnation', async () => {
    const tx = transaction();
    await publishMemberMessageProfileInTx(
      tx as never,
      candidate({ messageSeq: 24 }),
    );
    const evidenceQuery = sqlText(tx.execute.mock.calls[2]![0]);
    expect(evidenceQuery).toContain("'GROUP_JOINED'");
    expect(evidenceQuery).toContain('MAX(joined.seq)');
    expect(evidenceQuery).toContain('joined.content');
    expect(evidenceQuery).toContain('> COALESCE');
  });

  it('requires the newest eligible message for the member revision', async () => {
    const tx = transaction();
    await publishMemberMessageProfileInTx(tx as never, candidate());
    const evidenceQuery = sqlText(tx.execute.mock.calls[2]![0]);
    expect(evidenceQuery).toContain('NOT EXISTS');
    expect(evidenceQuery).toContain('newer.seq > m.seq');
    expect(evidenceQuery).toContain('newer."profileNamespaceId"');
    expect(evidenceQuery).toContain('newer."profileRev"');
  });

  it('advances metadata at metaEndId plus one and records the source seq', async () => {
    const tx = transaction();
    await publishMemberMessageProfileInTx(tx as never, candidate());
    const updateFeed = sqlText(tx.execute.mock.calls[3]![0]);
    const updateMeta = sqlText(tx.execute.mock.calls[4]![0]);
    expect(updateFeed).toContain('profileSourceSeq');
    expect(updateFeed).toContain('jsonb_set');
    expect(updateMeta).toContain('metaEndId');
    expect(enqueueCurrentThreadFanoutsInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ threadId: 9 }),
    );
  });
});
