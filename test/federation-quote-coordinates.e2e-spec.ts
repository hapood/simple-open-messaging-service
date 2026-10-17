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
import { wirePayloadDigest } from '../src/federation/federated-message-content.js';
import { forwardBundleDigest } from '../src/forward/forward-bundle.service.js';
import { payloadDigest } from '../src/federation/canonical-json.js';
import { FederationInboundMessageStoreService } from '../src/federation/federation-inbound-message-store.service.js';
import {
  FederationMessageFeedService,
  type FederationMessageFeedMessage,
} from '../src/federation/federation-message-feed.service.js';
import type { FederationQuoteTarget } from '../src/federation/federation-quote-target.js';
import { ForwardBundleService } from '../src/forward/forward-bundle.service.js';
import { resolveStoredQuotes } from '../src/message/quote-reference.js';
import { FederationInboundMessageValidatorService } from '../src/federation/federation-inbound-message-validator.service.js';
import { truncateTablesForTest } from './support/truncate';
import { assertFederationMessageWire } from './support/federation-wire-schema.js';

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
    undefined as never, // receipt path unused in this spec
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
          // The IdentityNamespace_one_epoch_per_root_key unique index forbids
          // two non-retired namespaces from sharing a root key, so derive a
          // distinct 32-byte key per domain instead of a shared placeholder.
          rootPublicKey: Buffer.from(domain.padEnd(32, '\0'), 'utf8').toString(
            'base64',
          ),
          identityPinnedAt: new Date(),
        })
        .returning();
      namespaces.set(domain, namespace.id);
    }
  });
  afterAll(async () => mod.close());
  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
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
    const seededContentType = overrides.contentType ?? ContentType.PURE_TEXT;
    const seededContent =
      overrides.content ?? JSON.stringify({ text: `message ${seq}` });
    const [row] = await database.db
      .insert(tables.message)
      .values({
        threadId: view.threadId,
        seq,
        originSeq: seq,
        contentType: seededContentType,
        content: seededContent,
        creatorAccount: 'user',
        updatedAt: new Date(),
        payloadDigest: wirePayloadDigest(seededContentType, seededContent),
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        ...overrides,
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
          },
        ],
        peer.namespaceId,
        { account: '!quote' },
      ),
    );
    assertFederationMessageWire(wire);
    new FederationInboundMessageValidatorService().assertEnvelope(wire);
    return wire;
  }

  async function receive(
    view: View,
    peer: View,
    seq: number,
    quoteTarget: FederationQuoteTarget,
    quoteDigest: string | undefined,
  ) {
    new FederationInboundMessageValidatorService().assertEnvelope({
      thread: { account: '!quote' },
      author: { account: 'user', namespaceId: 0 },
      seq,
      profileRev: 0,
      originSeq: null,
      originCreatedAt: null,
      contentType: ContentType.PURE_TEXT,
      content: JSON.stringify({ text: 'reply' }),
      createdAt: 1_700_000_000_000,
      assets: [],
      quoteTarget,
      quoteDigest,
    });
    const result = await database.db.transaction((tx) =>
      store.store(tx, {
        threadId: view.threadId,
        creator: { account: 'user', namespaceId: peer.namespaceId },
        fetchedFromDomain: peer.domain,
        namespaceId: peer.namespaceId,
        profileNamespaceId: peer.namespaceId,
        federationEnvelopeDigest: 'e'.repeat(64),
        message: {
          originSeq: seq,
          profileRev: 0,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'reply' }),
          ts: 1_700_000_000_000,
          quoteTarget,
          quoteDigest,
        },
        expectedFederationVersion: 0,
        incomingText: { text: 'reply' },
        originTime: new Date(1_700_000_000_000),
        payloadDigest: payloadDigest(
          JSON.stringify({ text: 'reply' }),
          [],
          quoteDigest,
        ),
      }),
    );
    if (result.kind !== 'message') throw new Error('text unexpectedly pending');
    return result.message;
  }

  it('converts a mirror quote of an authority target on publication, not on receipt', async () => {
    await seed(alpha, 41);
    await seed(charlie, 8, {
      originSeq: 41,
      publisherNamespaceId: alpha.namespaceId,
      profileNamespaceId: alpha.namespaceId,
    });
    await seed(bravo, 3, {
      originSeq: 41,
      publisherNamespaceId: alpha.namespaceId,
      profileNamespaceId: alpha.namespaceId,
    });
    const reply = await seed(charlie, 10, {
      content: JSON.stringify({
        text: 'reply',
        quote: {
          seq: 8,
          namespaceId: 0,
          digest: wirePayloadDigest(
            ContentType.PURE_TEXT,
            JSON.stringify({ text: 'message 8' }),
          ),
        },
      }),
    });
    const submission = await publish(charlie, alpha, reply);
    expect(submission.quoteTarget).toEqual({ originSeq: 41 });
    const authoritativeReply = await receive(
      alpha,
      charlie,
      submission.seq,
      submission.quoteTarget!,
      submission.quoteDigest,
    );
    expect(JSON.parse(authoritativeReply.content).quote).toMatchObject({
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
      distribution.quoteDigest,
    );
    expect(JSON.parse(mirroredReply.content).quote).toMatchObject({
      seq: 41,
      namespaceId: alpha.namespaceId,
    });
    const [projected] = await resolveStoredQuotes(database.db, [mirroredReply]);
    expect(JSON.parse(projected.content).quote).toMatchObject({ seq: 3 });
    expect(JSON.parse(mirroredReply.content).quote.seq).toBe(41);
  });

  it('isolates duplicate peer origin sequences and republishes the withdrawn target in authority coordinates', async () => {
    await seed(alpha, 31, {
      originSeq: 8,
      publisherNamespaceId: bravo.namespaceId,
      profileNamespaceId: bravo.namespaceId,
    });
    await seed(alpha, 42, {
      originSeq: 8,
      publisherNamespaceId: charlie.namespaceId,
      profileNamespaceId: charlie.namespaceId,
      isDeleted: true,
    });
    // The mirror's own target has not received its authority coordinates yet.
    await seed(charlie, 8, { originSeq: null });
    const reply = await seed(charlie, 10, {
      content: JSON.stringify({
        text: 'reply',
        quote: {
          seq: 8,
          namespaceId: 0,
          digest: wirePayloadDigest(
            ContentType.PURE_TEXT,
            JSON.stringify({ text: 'message 8' }),
          ),
        },
      }),
    });
    const submission = await publish(charlie, alpha, reply);
    expect(submission.quoteTarget).toEqual({ seq: 8 });
    const authoritativeReply = await receive(
      alpha,
      charlie,
      submission.seq,
      submission.quoteTarget!,
      submission.quoteDigest,
    );
    expect(JSON.parse(authoritativeReply.content).quote).toMatchObject({
      seq: 8,
      namespaceId: charlie.namespaceId,
    });
    const distribution = await publish(alpha, bravo, authoritativeReply);
    expect(distribution.quoteTarget).toEqual({ seq: 42 });
    const [projected] = await resolveStoredQuotes(database.db, [
      authoritativeReply,
    ]);
    expect(JSON.parse(projected.content).quote).toMatchObject({
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
          profile: { displayName: 'user' },
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'reply without a target entry' }),
          sentAt: 1,
          quoteTargetId: seq,
        },
      ];
      const imported = await forwards.importClosure(bravo.domain, {
        id: forwardBundleDigest(messages, []),
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

  it.each([{ seq: 0 }, { originSeq: 0 }])(
    'rejects zero coordinate %j before persistence',
    async (coordinate) => {
      await expect(
        receive(alpha, charlie, 51, coordinate, 'd'.repeat(64)),
      ).rejects.toThrow('invalid federated reply target');
      expect(await database.db.query.message.findMany()).toEqual([]);
    },
  );

  it('retains a missing authority target across receipt and redistribution using originSeq', async () => {
    const digest = 'd'.repeat(64);
    const reply = await receive(alpha, charlie, 51, { originSeq: 41 }, digest);
    const distribution = await publish(alpha, bravo, reply);
    expect(distribution.quoteTarget).toEqual({ seq: 41 });
    expect(distribution.quoteDigest).toBe(digest);
    const mirrored = await receive(
      bravo,
      alpha,
      distribution.seq,
      distribution.quoteTarget!,
      distribution.quoteDigest!,
    );
    const [projected] = await resolveStoredQuotes(database.db, [mirrored]);
    expect(JSON.parse(projected.content).quote).toMatchObject({
      seq: 0,
      sourceSeq: 41,
      status: 'PENDING',
      digest,
    });
    const returning = await publish(bravo, alpha, mirrored);
    expect(returning.quoteTarget).toEqual({ originSeq: 41 });
    expect(returning.quoteDigest).toBe(digest);
  });

  it('persists a missing target unchanged and distinguishes unpulled from confirmed absence', async () => {
    const reply = await receive(bravo, alpha, 51, { seq: 41 }, 'd'.repeat(64));
    expect(JSON.parse(reply.content).quote).toMatchObject({
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
    });
    const [absent] = await resolveStoredQuotes(database.db, [reply]);
    expect(JSON.parse(absent.content).quote.status).toBe('NOT_FOUND');
    const retained = await database.db.query.message.findFirst({
      where: eq(tables.message.id, reply.id),
    });
    expect(retained?.content).toBe(reply.content);
    const target = await seed(bravo, 3, {
      originSeq: 41,
      publisherNamespaceId: alpha.namespaceId,
      profileNamespaceId: alpha.namespaceId,
    });
    const [resolved] = await resolveStoredQuotes(database.db, [reply]);
    expect(JSON.parse(resolved.content).quote).toMatchObject({
      seq: target.seq,
    });
  });
});
