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

function groupReceipt(): FederationMessageFeedMessage {
  return {
    ...groupMessage('local.test'),
    originSeq: 3,
    originCreatedAt: 1_700_000_000_000,
  };
}

describe('FederationInboundMessageRouteService', () => {
  it('binds member retractions to a retained source-authored message and active member route', async () => {
    const routes = service();
    const memberRoute = vi.spyOn(routes, 'resolveMessage').mockResolvedValue({
      threadId: 11,
      federationVersion: 4,
      toAccount: '!group',
      creatorAccount: 'alice',
      creatorDomain: 'peer.test',
      authority: 'PEER',
      recipients: [],
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ account: 'alice' }] });
    await expect(
      routes.resolveTombstone(
        { execute } as never,
        { account: '!group' },
        'peer.test',
        9,
        7,
      ),
    ).resolves.toMatchObject({
      threadId: 11,
      memberSubmission: true,
      groupOriginDomain: 'local.test',
    });
    expect(memberRoute).toHaveBeenCalledWith(
      expect.anything(),
      {
        thread: { account: '!group' },
        author: { account: 'alice', domain: 'peer.test' },
      },
      'peer.test',
      9,
    );
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL);
    expect(query.sql).toContain('m."creatorDomain" =');
    expect(query.sql).toContain('m."sourceNamespaceId" =');
    expect(query.sql).toContain('m."originSeq" =');
    expect(query.params).toEqual(['GROUP', '!group', 9, 7, 'peer.test']);
  });

  it('rejects unknown or foreign-authored member retractions without inventing pending facts', async () => {
    const routes = service();
    const resolveMessage = vi.spyOn(routes, 'resolveMessage');
    await expect(
      routes.resolveTombstone(
        { execute: vi.fn().mockResolvedValue({ rows: [] }) } as never,
        { account: '!group' },
        'peer.test',
        9,
        7,
      ),
    ).rejects.toThrow('tombstone has no retained local group thread');
    expect(resolveMessage).not.toHaveBeenCalled();
  });

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
      authority: 'PEER',
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

  it('routes a mirror receipt by local group and audience before target association', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ threadId: 11, federationVersion: 4, toAccount: '!group' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      service().resolveMessage(tx, groupReceipt(), 'peer.test', 9),
    ).resolves.toMatchObject({
      threadId: 11,
      creatorDomain: 'local',
      authority: 'LOCAL',
    });
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL);
    expect(query.sql).not.toContain('JOIN "Message"');
    expect(query.sql).toContain('pair.active = true');
  });

  it.each([
    ['third.test', 'PEER'],
    ['local.test', 'LOCAL'],
  ] as const)(
    'derives %s group-message authority from the author domain, not originSeq',
    async (authorDomain, authority) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ threadId: 11, federationVersion: 4, toAccount: '!group' }],
        })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service().resolveMessage(
          { execute } as unknown as DatabaseTransaction,
          {
            ...groupReceipt(),
            author: { account: 'alice', domain: authorDomain },
          },
          'group.test',
          9,
        ),
      ).resolves.toMatchObject({ authority });
    },
  );

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
    ).rejects.toThrow(
      'group mirror may only submit its locally managed authors',
    );

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
