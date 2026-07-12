import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service.js';
import { PrismaModule } from '../src/prisma.module.js';
import { QuotaModule } from '../src/quota/quota.module.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import { ContentType } from '../src/prisma/generated/client.js';
import { MessageController } from '../src/controller/message.controller.js';

/**
 * DB-backed QuotaService tests. Validates the core invariants: the atomic `INSERT … ON CONFLICT …
 * RETURNING count` increment (the codebase's first $queryRaw), the EXACT count+rollback (over-limit
 * rolls back so the counter never exceeds the limit — not the doc's ±1 slop), the byte cap, and
 * per-node override resolution (peer columns vs the local SystemSetting KV). Runs against the isolated
 * soms_test DB provisioned by the e2e vitest config.
 */
const PEER = 'quota-peer.local';

describe('QuotaService (DB-backed)', () => {
  let quota: QuotaService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PrismaModule, QuotaModule],
    }).compile();
    quota = mod.get(QuotaService);
    prisma = mod.get(PrismaService);
    // setLimits on a peer requires a FederatedPeer row to exist.
    await prisma.federatedPeer.upsert({
      where: { domain: PEER },
      create: { domain: PEER, trustLevel: 'trusted' },
      update: {},
    });
  });

  beforeEach(async () => {
    // Clean slate: all counters + both nodes' overrides.
    await prisma.quotaDailyUsage.deleteMany({});
    await prisma.federatedPeer.update({
      where: { domain: PEER },
      data: {
        dailyMsgLimit: null,
        dailyImageLimit: null,
        dailyLargeFileLimit: null,
        dailyRequestLimit: null,
        maxImageBytes: null,
        maxLargeFileBytes: null,
      },
    });
    await prisma.systemSetting.deleteMany({
      where: { key: QuotaService.LOCAL_KEY },
    });
  });

  afterAll(async () => {
    await prisma.federatedPeer.deleteMany({ where: { domain: PEER } });
    await prisma.quotaDailyUsage.deleteMany({});
    await prisma.systemSetting.deleteMany({
      where: { key: QuotaService.LOCAL_KEY },
    });
    await prisma.$disconnect();
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
    await expect(quota.assertUnderCap(PEER, 'images', 101)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
    });
    await expect(quota.assertUnderCap(PEER, 'images', 100)).resolves.toBeUndefined();
    // count-only categories have no byte cap → never throws.
    await expect(quota.assertUnderCap(PEER, 'messages', 1e12)).resolves.toBeUndefined();
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
      { writeMsgToThread: async () => ({}) } as unknown as ConstructorParameters<typeof MessageController>[0],
      {} as ConstructorParameters<typeof MessageController>[1],
      {} as ConstructorParameters<typeof MessageController>[2],
      {} as ConstructorParameters<typeof MessageController>[3],
      { dispatch: () => undefined } as unknown as ConstructorParameters<typeof MessageController>[4],
      quota,
    );
    const req = { user: { userId: 1 } } as unknown as Parameters<InstanceType<typeof MessageController>['sendMessage']>[0];
    const dto = { threadId: 1, content: 'hi', contentType: ContentType.PURE_TEXT };
    // 1st send: under the limit → proceeds (code OK).
    const r1 = await ctrl.sendMessage(req, dto as never);
    expect(r1.code).toBe(BusinessCode.OK);
    // 2nd send: over the limit → 200 + QUOTA_EXCEEDED, carrying the category + retryAfter.
    const r2 = await ctrl.sendMessage(req, { ...dto, content: 'hi2' } as never);
    expect(r2.code).toBe(BusinessCode.QUOTA_EXCEEDED);
    expect((r2.data as { category: string }).category).toBe('messages');
  });
});
