import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';

const dialect = new PgDialect();

function service() {
  return Object.create(
    FederationInboundMessageRouteService.prototype,
  ) as FederationInboundMessageRouteService & Record<string, unknown>;
}

function groupMessage(authorNamespaceId = 0): FederationMessageFeedMessage {
  return {
    thread: { account: '!group' },
    author: { account: 'alice', namespaceId: authorNamespaceId },
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
    ...groupMessage(12),
    originSeq: 3,
    originCreatedAt: 1_700_000_000_000,
  };
}

describe('FederationInboundMessageRouteService', () => {
  it('accepts a P2P processing receipt for the local thread peer account mirrored by the peer', () => {
    const message: FederationMessageFeedMessage = {
      ...groupMessage(2),
      thread: { account: 'bob', peerAccount: 'carol' },
      author: { ref: 'THREAD_PEER_ACCOUNT', namespaceId: 2 },
      originSeq: 2,
      originCreatedAt: 1_700_000_000_000,
    };

    expect(service().messageAuthor(message, 'peer.test', 1)).toEqual({
      account: 'carol',
      namespaceId: 0,
    });
  });

  it('rejects the obsolete P2P receipt shape that marks the thread account as receiver-local', () => {
    const message: FederationMessageFeedMessage = {
      ...groupMessage(12),
      thread: { account: 'carol', peerAccount: 'bob' },
      author: { ref: 'THREAD_ACCOUNT', namespaceId: 12 },
      originSeq: 2,
      originCreatedAt: 1_700_000_000_000,
    };

    expect(() => service().messageAuthor(message, 'peer.test', 12)).toThrow(
      'P2P author reference conflicts with namespaceId',
    );
  });

  it('keeps a publisher-local P2P author in profile namespace zero', () => {
    const message: FederationMessageFeedMessage = {
      ...groupMessage(0),
      thread: { account: 'bob', peerAccount: 'alice' },
      author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
    };

    expect(service().messageAuthor(message, 'peer.test', 12)).toEqual({
      account: 'bob',
      namespaceId: 0,
    });
  });

  it('classifies P2P tombstones as author-home facts, not local submissions', async () => {
    const routes = service();
    const resolveMessage = vi
      .spyOn(routes, 'resolveMessage')
      .mockResolvedValue({
        threadId: 11,
        federationVersion: 4,
        toAccount: 'alice',
        creatorAccount: 'bob',
        profileNamespaceId: 7,
        authority: 'PEER',
        recipients: [],
      });
    await expect(
      routes.resolveTombstone(
        {} as DatabaseTransaction,
        { account: 'bob', peerAccount: 'alice' },
        'peer.test',
        9,
        7,
      ),
    ).resolves.toMatchObject({ authority: 'P2P_HOME' });
    expect(resolveMessage).toHaveBeenCalledOnce();
  });

  it('binds member retractions to a retained source-authored message and active member route', async () => {
    const routes = service();
    const memberRoute = vi.spyOn(routes, 'resolveMessage').mockResolvedValue({
      threadId: 11,
      federationVersion: 4,
      toAccount: '!group',
      creatorAccount: 'alice',
      profileNamespaceId: 9,
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
        7,
      ),
    ).resolves.toMatchObject({
      threadId: 11,
      authority: 'GROUP_MEMBER',
    });
    expect(memberRoute).toHaveBeenCalledWith(
      expect.anything(),
      {
        thread: { account: '!group' },
        author: { account: 'alice', namespaceId: 0 },
      },
      'peer.test',
      9,
      7,
    );
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL);
    expect(query.sql).toContain('m."profileNamespaceId" IN (0, $5)');
    expect(query.sql).toContain('m."publisherNamespaceId" = $3');
    expect(query.sql).toContain('m."originSeq" = $4');
    expect(query.sql).toContain('m."originServerTime" IS NOT NULL');
    expect(query.params).toEqual(['GROUP', '!group', 9, 7, 9, 7]);
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
      service().resolveMessage(tx, groupMessage(), 'peer.test', 9, 7),
    ).resolves.toEqual({
      threadId: 11,
      federationVersion: 4,
      toAccount: '!group',
      creatorAccount: 'alice',
      profileNamespaceId: 0,
      authority: 'PEER',
      recipients: [],
    });

    const query = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL);
    expect(query.sql).toContain('group_user."namespaceId" = 0');
    expect(query.sql).toContain('FROM "RelationshipPair" pair');
    expect(query.sql).toContain("pair.kind = 'GROUP_MEMBER'");
    expect(query.sql).toContain('pair.active = true');
    expect(query.params).toContain('alice');
    expect(query.params).toContain(9);
  });

  it.each(
    [12, 13].flatMap((authorNamespaceId) =>
      [false, true].map((receipt) => ({ authorNamespaceId, receipt })),
    ),
  )(
    'filters non-home authors before receipt or member routing (namespace=$authorNamespaceId, receipt=$receipt)',
    async ({ authorNamespaceId, receipt }) => {
      const execute = vi.fn().mockResolvedValue({ rows: [] });
      await expect(
        service().resolveMessage(
          { execute } as unknown as DatabaseTransaction,
          {
            ...groupMessage(authorNamespaceId),
            ...(receipt
              ? { originSeq: 3, originCreatedAt: 1_700_000_000_000 }
              : {}),
          },
          'peer.test',
          9,
          12,
        ),
      ).rejects.toThrow(
        'group mirror may only submit its locally managed authors',
      );
      // Only the peer-origin lookup runs: no local receipt-target lookup,
      // membership lookup, or recipient resolution is attempted for this item.
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [13, 13, 'PEER'],
    [12, 12, 'LOCAL'],
  ] as const)(
    'derives group-message authority from peer-assigned namespace, not domain comparison',
    async (authorNamespaceId, namespaceId, authority) => {
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
            author: { account: 'alice', namespaceId: authorNamespaceId },
          },
          'group.test',
          9,
          12,
        ),
      ).resolves.toMatchObject({ authority });
    },
  );

  it('does not authorize the local-origin branch for a forwarded third-party author', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      service().resolveMessage(tx, groupMessage(13), 'peer.test', 9, 7),
    ).rejects.toThrow(
      'group mirror may only submit its locally managed authors',
    );

    expect(execute).toHaveBeenCalledOnce();
  });

  it('scopes group tombstones to a group hosted by the authenticated peer', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { execute } as unknown as DatabaseTransaction;

    await expect(
      service().resolveTombstone(
        tx,
        { account: '!group' },
        'origin.test',
        9,
        7,
      ),
    ).rejects.toThrow('tombstone has no retained local group thread');

    const query = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/group_user\.domain = \$\d+/);
    expect(query.params).toContain('origin.test');
  });
});
