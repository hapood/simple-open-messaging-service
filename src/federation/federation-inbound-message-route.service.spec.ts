import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';

const dialect = new PgDialect();

function service() {
  const value = Object.create(
    FederationInboundMessageRouteService.prototype,
  ) as FederationInboundMessageRouteService & Record<string, unknown>;
  Object.assign(value, { config: { domain: 'local.test' } });
  return value;
}

function groupMessage(authorDomain = 'local'): FederationMessageFeedMessage {
  return {
    thread: { account: '!group' },
    author: { account: 'alice', domain: authorDomain },
    seq: 7,
    profileRev: 1,
    originSeq: null,
    originCreatedAt: null,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: 'hello' }),
    createdAt: 1_700_000_000_000,
    assets: [],
  };
}

describe('FederationInboundMessageRouteService', () => {
  it('routes a source-authored member message to an active local authoritative group', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ threadId: 11, federationVersion: 4, toAccount: '!group' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      service().resolveMessage(tx, groupMessage(), 'peer.test', 9),
    ).resolves.toEqual({
      threadId: 11,
      federationVersion: 4,
      toAccount: '!group',
      creatorAccount: 'alice',
      creatorDomain: 'peer.test',
      recipients: [],
    });

    const query = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL);
    expect(query.sql).toContain("group_user.domain = 'local'");
    expect(query.sql).toContain('FROM "RelationshipPair" pair');
    expect(query.sql).toContain("pair.kind = 'GROUP_MEMBER'");
    expect(query.sql).toContain('pair.active = true');
    expect(query.params).toContain('alice');
    expect(query.params).toContain('peer.test');
    expect(query.params).toContain(9);
  });

  it('does not authorize the local-origin branch for a forwarded third-party author', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      service().resolveMessage(
        tx,
        groupMessage('third-party.test'),
        'peer.test',
        9,
      ),
    ).rejects.toThrow('missed message has no retained local thread');

    expect(execute).toHaveBeenCalledOnce();
  });

  it('scopes group tombstones to a group hosted by the authenticated peer', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      service().resolveTombstone(tx, { account: '!group' }, 'origin.test', 9),
    ).rejects.toThrow('tombstone has no retained local group thread');

    const query = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/group_user\.domain = \$\d+/);
    expect(query.params).toContain('origin.test');
  });
});
