import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { ContentType } from '../src/database/enums.js';
import { FederationInboundMessageStoreService } from '../src/federation/federation-inbound-message-store.service.js';
import {
  FederationMessageFeedService,
  type FederationMessageFeedMessage,
} from '../src/federation/federation-message-feed.service.js';
import type { FederationQuoteTarget } from '../src/federation/federation-quote-target.js';
import { ForwardBundleService } from '../src/forward/forward-bundle.service.js';
import { resolveStoredQuotes } from '../src/message/quote-reference.js';
import { FederationInboundMessageValidatorService } from '../src/federation/federation-inbound-message-validator.service.js';

type Message = typeof tables.message.$inferSelect;
type View = {
  threadId: number;
  authorityNamespaceId: number;
  domain: string;
  namespaceId: number;
};

describe('federation quote coordinates across three persisted node views', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let alpha: View;
  let bravo: View;
  let charlie: View;
  const namespaces = new Map<string, number>();
  const store = new FederationInboundMessageStoreService(
    { assertResponseWritable: vi.fn() } as never,
    {} as never,
    { tickLax: vi.fn() } as never,
  );

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    for (const domain of [
      'alpha.quote.test',
      'bravo.quote.test',
      'charlie.quote.test',
    ]) {
      const [namespace] = await database.db
        .insert(tables.identityNamespace)
        .values({
          domain,
          rootKeyFingerprint: `sha256:${domain}`,
          rootPublicKey: Buffer.alloc(32, 3).toString('base64'),
          identityPinnedAt: new Date(),
        })
        .returning();
      namespaces.set(domain, namespace.id);
    }
  });
  afterAll(async () => mod.close());
  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "MessageThread", "GroupAccount", "Profile" RESTART IDENTITY CASCADE',
    );
    const views: View[] = [];
    for (const [domain, namespaceId] of namespaces) {
      const authorityNamespaceId =
        views.length === 0 ? 0 : namespaces.get('alpha.quote.test')!;
      const groupAccount = `!quote-${views.length}`;
      const [localGroup] =
        authorityNamespaceId === 0
          ? await database.db
              .insert(tables.groupAccount)
              .values({ account: groupAccount, updatedAt: new Date() })
              .returning()
          : [];
      const [thread] = await database.db
        .insert(tables.messageThread)
        .values({
          type: 'GROUP',
          groupAccount,
          groupDomain: localGroup ? 'local' : 'alpha.quote.test',
          groupAccountId: localGroup?.id,
          authorityNamespaceId,
          curSeq: 50,
          updatedAt: new Date(),
        })
        .returning();
      views.push({
        threadId: thread.id,
        authorityNamespaceId,
        domain,
        namespaceId,
      });
    }
    [alpha, bravo, charlie] = views;
  });

  async function seed(
    view: View,
    seq: number,
    overrides: Partial<typeof tables.message.$inferInsert> = {},
  ) {
    const [row] = await database.db
      .insert(tables.message)
      .values({
        threadId: view.threadId,
        seq,
        originSeq: seq,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: `message ${seq}` }),
        creatorAccount: 'user',
        creatorDomain: 'local',
        updatedAt: new Date(),
        ...overrides,
        creatorNamespaceId:
          overrides.creatorNamespaceId ??
          (overrides.creatorDomain && overrides.creatorDomain !== 'local'
            ? Number(overrides.sourceNamespaceId)
            : 0),
      })
      .returning();
    return row;
  }

  async function publish(view: View, peer: View, row: Message) {
    const service = Object.create(FederationMessageFeedService.prototype) as {
      localDomain: string;
      serializeMessagesInTx(
        tx: DatabaseTransaction,
        rows: unknown[],
        domain: string,
        namespaceId: number,
        thread: { account: string },
      ): Promise<FederationMessageFeedMessage[]>;
    };
    service.localDomain = view.domain;
    const [wire] = await database.db.transaction((tx) =>
      service.serializeMessagesInTx(
        tx,
        [
          {
            ...row,
            messageId: row.id,
            threadType: 'GROUP',
            groupId: view.threadId,
            authorityNamespaceId: view.authorityNamespaceId,
            authorAccount: row.creatorAccount,
            authorDomain: row.creatorDomain,
          },
        ],
        peer.domain,
        peer.namespaceId,
        { account: '!quote' },
      ),
    );
    new FederationInboundMessageValidatorService().assertEnvelope(wire);
    return wire;
  }

  async function receive(
    view: View,
    peer: View,
    seq: number,
    quoteTarget: FederationQuoteTarget,
  ) {
    const result = await database.db.transaction((tx) =>
      store.store(tx, {
        threadId: view.threadId,
        creator: { account: 'user', domain: peer.domain },
        fetchedFromDomain: peer.domain,
        namespaceId: peer.namespaceId,
        message: {
          originSeq: seq,
          profileRev: 0,
          clientMessageId: null,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'reply' }),
          ts: 1_700_000_000_000,
          quoteTarget,
        },
        expectedFederationVersion: 0,
        incomingText: { text: 'reply' },
        originTime: new Date(1_700_000_000_000),
      }),
    );
    if (result.kind !== 'message') throw new Error('text unexpectedly pending');
    return result.message;
  }

  it('converts a mirror quote of an authority target on publication, not on receipt', async () => {
    await seed(alpha, 41);
    await seed(charlie, 8, {
      originSeq: 41,
      sourceNamespaceId: alpha.namespaceId,
      creatorDomain: alpha.domain,
    });
    await seed(bravo, 3, {
      originSeq: 41,
      sourceNamespaceId: alpha.namespaceId,
      creatorDomain: alpha.domain,
    });
    const reply = await seed(charlie, 10, {
      content: JSON.stringify({
        text: 'reply',
        quote: { seq: 8, namespaceId: 0 },
      }),
    });
    const submission = await publish(charlie, alpha, reply);
    expect(submission.quoteTarget).toEqual({ originSeq: 41 });
    const authoritativeReply = await receive(
      alpha,
      charlie,
      submission.seq,
      submission.quoteTarget!,
    );
    expect(JSON.parse(authoritativeReply.content).quote).toEqual({
      seq: 41,
      namespaceId: 0,
    });
    const distribution = await publish(alpha, bravo, authoritativeReply);
    expect(distribution.quoteTarget).toEqual({ seq: 41 });
    const mirroredReply = await receive(
      bravo,
      alpha,
      distribution.seq,
      distribution.quoteTarget!,
    );
    expect(JSON.parse(mirroredReply.content).quote).toEqual({
      seq: 41,
      namespaceId: alpha.namespaceId,
    });
    const [projected] = await resolveStoredQuotes(database.db, [mirroredReply]);
    expect(JSON.parse(projected.content).quote).toEqual({ seq: 3 });
    expect(JSON.parse(mirroredReply.content).quote.seq).toBe(41);
  });

  it('isolates duplicate peer origin sequences and republishes the withdrawn target in authority coordinates', async () => {
    await seed(alpha, 31, {
      originSeq: 8,
      sourceNamespaceId: bravo.namespaceId,
      creatorDomain: bravo.domain,
    });
    await seed(alpha, 42, {
      originSeq: 8,
      sourceNamespaceId: charlie.namespaceId,
      creatorDomain: charlie.domain,
      isDeleted: true,
    });
    await seed(charlie, 8, {
      originSeq: 42,
      sourceNamespaceId: alpha.namespaceId,
    });
    const reply = await seed(charlie, 10, {
      content: JSON.stringify({
        text: 'reply',
        quote: { seq: 8, namespaceId: 0 },
      }),
    });
    const submission = await publish(charlie, alpha, reply);
    expect(submission.quoteTarget).toEqual({ seq: 8 });
    const authoritativeReply = await receive(
      alpha,
      charlie,
      submission.seq,
      submission.quoteTarget!,
    );
    expect(JSON.parse(authoritativeReply.content).quote).toEqual({
      seq: 8,
      namespaceId: charlie.namespaceId,
    });
    const distribution = await publish(alpha, bravo, authoritativeReply);
    expect(distribution.quoteTarget).toEqual({ seq: 42 });
    const [projected] = await resolveStoredQuotes(database.db, [
      authoritativeReply,
    ]);
    expect(JSON.parse(projected.content).quote).toEqual({
      seq: 42,
      status: 'NOT_FOUND',
    });
  });

  it.each([0, 99])(
    'imports and republishes a bundle with absent target %i',
    async (seq) => {
      const forwards = new ForwardBundleService(
        database,
        {} as never,
        {} as never,
      );
      const messages = [
        {
          id: 1,
          author: { account: 'user', domain: bravo.domain },
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'reply without a target entry' }),
          sentAt: 1,
          quoteTargetId: seq,
        },
      ];
      const imported = await forwards.importClosure(bravo.domain, {
        id: `absent-quote-${seq}`,
        messages,
        children: [],
        assets: [],
      });
      const stored = await database.db.query.forwardBundle.findFirst({
        where: eq(tables.forwardBundle.id, imported.localRootBundleId),
      });
      expect(stored?.messages).toEqual(messages);
      expect(
        (await forwards.buildClosure(imported.localRootBundleId)).messages,
      ).toEqual(messages);
    },
  );

  it('keeps an explicit absent quote through receipt, redistribution, and reads', async () => {
    const reply = await receive(alpha, charlie, 51, { seq: 0 });
    expect(JSON.parse(reply.content).quote).toEqual({ seq: 0, namespaceId: 0 });
    const distribution = await publish(alpha, bravo, reply);
    expect(distribution.quoteTarget).toEqual({ seq: 0 });
    const mirrored = await receive(
      bravo,
      alpha,
      distribution.seq,
      distribution.quoteTarget!,
    );
    const [projected] = await resolveStoredQuotes(database.db, [mirrored]);
    expect(JSON.parse(projected.content).quote).toEqual({
      seq: 0,
      status: 'NOT_FOUND',
    });
    expect((await publish(bravo, alpha, mirrored)).quoteTarget).toEqual({
      seq: 0,
    });
  });

  it('persists a missing target unchanged and distinguishes unpulled from confirmed absence', async () => {
    const reply = await receive(bravo, alpha, 51, { seq: 41 });
    expect(JSON.parse(reply.content).quote).toEqual({
      seq: 41,
      namespaceId: alpha.namespaceId,
    });
    const [pending] = await resolveStoredQuotes(database.db, [reply]);
    expect(JSON.parse(pending.content).quote.status).toBe('PENDING');
    await database.db.insert(tables.federationThreadSyncState).values({
      threadId: bravo.threadId,
      namespaceId: alpha.namespaceId,
      messageTargetSeq: 51,
      messageProcessedThroughSeq: 51,
      historyBoundaryReached: true,
    });
    const [absent] = await resolveStoredQuotes(database.db, [reply]);
    expect(JSON.parse(absent.content).quote.status).toBe('NOT_FOUND');
    const retained = await database.db.query.message.findFirst({
      where: eq(tables.message.id, reply.id),
    });
    expect(retained?.content).toBe(reply.content);
    const target = await seed(bravo, 3, {
      originSeq: 41,
      sourceNamespaceId: alpha.namespaceId,
      creatorDomain: alpha.domain,
    });
    const [resolved] = await resolveStoredQuotes(database.db, [reply]);
    expect(JSON.parse(resolved.content).quote).toEqual({ seq: target.seq });
  });
});
