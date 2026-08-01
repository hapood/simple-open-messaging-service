import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../src/database/database.service.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { QuotaModule } from '../src/quota/quota.module.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import { BusinessException } from '../src/common/business.exception.js';
import { ContentType } from '../src/database/enums.js';
import { MessageController } from '../src/controller/message.controller.js';

/**
 * DB-backed QuotaService tests. Validates the core invariants: the atomic `INSERT … ON CONFLICT …
 * RETURNING count` increment, the EXACT count+rollback (over-limit
 * rolls back so the counter never exceeds the limit — not the doc's ±1 slop), the byte cap, and
 * per-node override resolution (peer columns vs the local SystemSetting KV). Runs against the isolated
 * soms_test DB provisioned by the e2e vitest config.
 */
const PEER = 'quota-peer.local';

describe('QuotaService (DB-backed)', () => {
  let quota: QuotaService;
  let database: DatabaseService;
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, QuotaModule],
    }).compile();
    quota = mod.get(QuotaService);
    database = mod.get(DatabaseService);
    // setLimits on a peer requires a FederatedPeer row to exist.
    await database.pool.query(
      'INSERT INTO "FederatedPeer" (domain, "trustLevel") VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING',
      [PEER, 'trusted'],
    );
  });

  beforeEach(async () => {
    // Clean slate: all counters + both nodes' overrides.
    await database.pool.query('DELETE FROM "QuotaDailyUsage"');
    await database.pool.query(
      'UPDATE "FederatedPeer" SET "dailyMsgLimit" = NULL, "dailyImageLimit" = NULL, "dailyLargeFileLimit" = NULL, "dailyRequestLimit" = NULL, "maxImageBytes" = NULL, "maxLargeFileBytes" = NULL WHERE domain = $1',
      [PEER],
    );
    await database.pool.query('DELETE FROM "SystemSetting" WHERE key = $1', [
      QuotaService.LOCAL_KEY,
    ]);
  });

  afterAll(async () => {
    await database.pool.query('DELETE FROM "FederatedPeer" WHERE domain = $1', [
      PEER,
    ]);
    await database.pool.query('DELETE FROM "QuotaDailyUsage"');
    await database.pool.query('DELETE FROM "SystemSetting" WHERE key = $1', [
      QuotaService.LOCAL_KEY,
    ]);
    await mod.close();
  });

  it('tick increments and throws (429) exactly past the limit — the over-limit increment rolls back', async () => {
    await quota.setLimits(PEER, { dailyMsgLimit: 2 });
    await quota.tick(PEER, 'messages'); // count 1
    await quota.tick(PEER, 'messages'); // count 2 = limit
    await expect(quota.tick(PEER, 'messages')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    // EXACT: the rejected 3rd did not persist → counter stays at the limit (2), not 3.
    expect((await quota.usageToday(PEER)).messages.count).toBe(2);
  });

  it('peek rejects at the limit WITHOUT writing (no count burn)', async () => {
    await quota.setLimits(PEER, { dailyRequestLimit: 1 });
    await quota.tick(PEER, 'requests'); // count 1 = limit
    await expect(quota.peek(PEER, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    // peek is read-only → count still 1.
    expect((await quota.usageToday(PEER)).requests.count).toBe(1);
  });

  it('tryTickLocal returns exceeded + rolls back (exact) on the local node', async () => {
    await quota.setLimits(quota.domain, { dailyMsgLimit: 2 });
    expect((await quota.tryTickLocal('messages')).exceeded).toBe(false);
    expect((await quota.tryTickLocal('messages')).exceeded).toBe(false);
    const over = await quota.tryTickLocal('messages');
    expect(over.exceeded).toBe(true);
    expect(over.limit).toBe(2);
    expect(over.retryAfter).toBeGreaterThan(0);
    // EXACT: the local aggregate counter stays at the limit (2).
    expect((await quota.usageToday(quota.domain)).messages.count).toBe(2);
  });

  it('assertUnderCap throws 413 over the byte cap and passes under it', async () => {
    await quota.setLimits(PEER, { maxImageBytes: 100 });
    await expect(
      quota.assertUnderCap(PEER, 'images', 101),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
    });
    await expect(
      quota.assertUnderCap(PEER, 'images', 100),
    ).resolves.toBeUndefined();
    // count-only categories have no byte cap → never throws.
    await expect(
      quota.assertUnderCap(PEER, 'messages', 1e12),
    ).resolves.toBeUndefined();
  });

  it('effective limit falls back to the global default when the override is null', async () => {
    await quota.setLimits(PEER, { dailyMsgLimit: null });
    expect((await quota.usageToday(PEER)).messages.limit).toBeGreaterThan(0);
  });

  it('listNodes includes the local node + the peer, each with today usage', async () => {
    await quota.tick(PEER, 'messages');
    const nodes = await quota.listNodes();
    expect(nodes.some((n) => n.isLocal)).toBe(true);
    const peer = nodes.find((n) => n.domain === PEER);
    expect(peer).toBeDefined();
    expect(peer!.usage!.messages.count).toBe(1);
  });

  it('MessageController.sendMessage returns 200+QUOTA_EXCEEDED past the local message limit', async () => {
    await quota.setLimits(quota.domain, { dailyMsgLimit: 1 });
    // Direct instantiation with stubbed deps — only `quota` is real; messageService/fanout are no-ops
    // (we are testing the controller↔QuotaService wiring, not message persistence).
    const ctrl = new MessageController(
      {
        writeMsgToThread: async () => ({}),
      } as unknown as ConstructorParameters<typeof MessageController>[0],
      {} as ConstructorParameters<typeof MessageController>[1],
      {} as ConstructorParameters<typeof MessageController>[2],
      {} as ConstructorParameters<typeof MessageController>[3],
      { dispatch: () => undefined } as unknown as ConstructorParameters<
        typeof MessageController
      >[4],
      quota,
      {
        assertP2PWritable: async () => undefined,
      } as unknown as ConstructorParameters<typeof MessageController>[6],
      {} as ConstructorParameters<typeof MessageController>[7],
      {} as ConstructorParameters<typeof MessageController>[8],
      {} as ConstructorParameters<typeof MessageController>[9],
    );
    const req = {
      user: { userId: 1 },
      threadAccess: {
        threadType: 'P2P',
        friendshipActive: true,
        membershipActive: true,
        groupDissolved: false,
        participant: { clearedSeq: null },
      },
    } as unknown as Parameters<
      InstanceType<typeof MessageController>['sendMessage']
    >[0];
    const dto = {
      threadId: 1,
      content: 'hi',
      contentType: ContentType.PURE_TEXT,
    };
    // 1st send: under the limit → proceeds (returns the written message; no throw).
    const r1 = await ctrl.sendMessage(req, dto as never);
    expect(r1).toBeDefined();
    // 2nd send: over the limit → throws BusinessException(QUOTA_EXCEEDED, ..., {category, limit, retryAfter});
    // the global AllExceptionsFilter renders that as HTTP 200 + the same {code, message, data} body.
    const r2 = await ctrl
      .sendMessage(req, { ...dto, content: 'hi2' } as never)
      .catch((e) => e as BusinessException);
    expect(r2).toBeInstanceOf(BusinessException);
    expect(r2.bizCode).toBe(BusinessCode.QUOTA_EXCEEDED);
    expect(
      (r2.getResponse() as { data: { category: string } }).data.category,
    ).toBe('messages');
  });
});
