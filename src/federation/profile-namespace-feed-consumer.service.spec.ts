import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceFeedConsumerService } from './profile-namespace-feed-consumer.service.js';

function harness() {
  const execute = vi.fn(async () => ({ rows: [] as unknown[] }));
  const recordClientChangeInTx = vi.fn(async () => 9n);
  const feed = { recordClientChangeInTx };
  const tx = { execute };
  const service = new ProfileNamespaceFeedConsumerService(feed as never);
  return { service, tx, execute, recordClientChangeInTx };
}

function sqlText(statement: unknown): string {
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
  if (chunks === undefined) {
    const value = (statement as { value?: unknown })?.value;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join('');
    return '';
  }
  return chunks.map((chunk) => sqlText(chunk)).join('');
}

describe('ProfileNamespaceFeedConsumerService', () => {
  it('expires matching rows and records a client changelog entry in the same transaction', async () => {
    const { service, tx, execute, recordClientChangeInTx } = harness();
    execute.mockResolvedValueOnce({
      rows: [{ publisherNamespaceId: 12 }],
    });
    const effect = await service.applyItemInTx(tx as never, 12, {
      namespaceId: 5,
      feedId: 9n,
    });
    expect(effect).toEqual({
      publisherNamespaceId: 12,
      profileNamespaceId: 5,
      triggerFeedId: 9n,
      expiredLocalRows: true,
      clientChangeId: 9n,
    });
    const text = execute.mock.calls
      .map((call: unknown[]) => sqlText(call[0]))
      .join('\n');
    expect(text).toContain('UPDATE "ProfileNamespace"');
    expect(text).toContain('SET expired = true');
    expect(text).toContain('"updateFeedId" <');
    expect(recordClientChangeInTx).toHaveBeenCalledWith(tx, {
      publisherNamespaceId: 12,
      profileNamespaceId: 5,
    });
  });

  it('records the changelog entry even when no local cache row matched', async () => {
    const { service, tx, recordClientChangeInTx } = harness();
    const effect = await service.applyItemInTx(tx as never, 12, {
      namespaceId: 7,
      feedId: 3n,
    });
    expect(effect.expiredLocalRows).toBe(false);
    expect(effect.clientChangeId).toBe(9n);
    expect(recordClientChangeInTx).toHaveBeenCalledOnce();
  });

  it('rejects malformed items', async () => {
    const { service, tx } = harness();
    await expect(
      service.applyItemInTx(tx as never, 12, {
        namespaceId: -1,
        feedId: 3n,
      }),
    ).rejects.toThrow('malformed');
    await expect(
      service.applyItemInTx(tx as never, 12, {
        namespaceId: 1,
        feedId: 0n,
      }),
    ).rejects.toThrow('malformed');
  });
});
