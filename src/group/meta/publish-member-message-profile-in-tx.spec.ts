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
    namespaceId: 0,
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

  it('selects without a stored profile snapshot and admits STUB evidence', async () => {
    const tx = transaction();
    await expect(
      publishMemberMessageProfileInTx(tx as never, candidate()),
    ).resolves.toBe(true);
    const evidenceQuery = sqlText(tx.execute.mock.calls[2]![0]);
    expect(evidenceQuery).not.toContain('"Profile"');
    expect(evidenceQuery).toContain("'READY', 'STUB'");
  });

  it('identifies a publisher-home member by the publisher namespace', async () => {
    const tx = transaction();
    await publishMemberMessageProfileInTx(tx as never, candidate());
    const memberQuery = new PgDialect().sqlToQuery(
      tx.execute.mock.calls[1]![0] as never,
    );
    expect(memberQuery.params).toContain(7);
  });

  it('maps a third-home subject through its pinned root-key binding', async () => {
    const tx = { execute: vi.fn() };
    tx.execute
      .mockResolvedValueOnce({ rows: [{ namespaceId: 19 }] })
      .mockResolvedValueOnce({ rows: [{ metaEndId: 40 }] })
      .mockResolvedValueOnce({
        rows: [{ profileRev: 5, profileSourceSeq: null }],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      publishMemberMessageProfileInTx(
        tx as never,
        candidate({ namespaceId: 12 }),
      ),
    ).resolves.toBe(true);
    const bindingQuery = sqlText(tx.execute.mock.calls[0]![0]);
    expect(bindingQuery).toContain(
      'identity."rootPublicKey" = binding."rootPublicKey"',
    );
    const memberQuery = new PgDialect().sqlToQuery(
      tx.execute.mock.calls[2]![0] as never,
    );
    const evidenceQuery = new PgDialect().sqlToQuery(
      tx.execute.mock.calls[3]![0] as never,
    );
    expect(memberQuery.params).toContain(19);
    expect(evidenceQuery.params).toContain(12);
  });

  it('rejects a third-home subject without a resolvable binding', async () => {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(
      publishMemberMessageProfileInTx(
        tx as never,
        candidate({ namespaceId: 12 }),
      ),
    ).resolves.toBe(false);
    expect(tx.execute).toHaveBeenCalledOnce();
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
