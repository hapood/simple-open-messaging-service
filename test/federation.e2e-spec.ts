import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bootFederationPair,
  truncateFederationDbs,
  makePng,
  TestDiscoveryService,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type BootedApp,
} from './federation-harness.js';
import { BusinessCode } from '../src/common/business-code.js';
import { AuthService } from '../src/auth/auth.service.js';
import { SignatureService } from '../src/federation/signature.service.js';
import { FederationService } from '../src/federation/federation.service.js';
import { UploadService } from '../src/upload/upload.service.js';
import { UserService } from '../src/user/user.service.js';
import { SseService } from '../src/gateway/sse.service.js';

/**
 * Federation e2e — two full SOMS apps (aaa.local + bbb.local) in one process, making real signed HTTP
 * requests to each other over loopback. Exercises the full S2S chain: signOutbound → fetch → Fastify
 * preParsing raw-body capture → content-digest + signature verify → init handshake → friend flows →
 * avatar localization → /revision staleness probe. See the harness header for the loopback trick.
 */

const DOM_A = FED_DOMAIN_A;
const DOM_B = FED_DOMAIN_B;

describe('Federation e2e (two nodes, real signed S2S traffic)', () => {
  let appA: BootedApp;
  let appB: BootedApp;
  let tokenA: string; // alice @ appA
  let tokenB: string; // bob @ appB
  let bobStubIdOnA: number; // appA's stub of bob (foreign)
  let aliceStubIdOnB: number; // appB's stub of alice (foreign)
  let aliceLocalIdA: number;
  let png2: Buffer; // second avatar (distinct color) for the re-pull test

  beforeAll(async () => {
    // Force tiny media chunks so a modest fixture file spans multiple Range requests — exercises the
    // resumable multi-chunk transport without allocating a multi-MB blob. Set BEFORE boot so the config
    // (loaded at FederationService field-init) picks it up. Avatars use a different (base64 inline) path,
    // so only /get_file chat-media is affected; the other tests still pass.
    process.env.SOMS_MEDIA_CHUNK_BYTES = '64';
    // Boot appA (aaa.local) + appB (bbb.local) on SEPARATE databases. bootFederationPair creates the two
    // per-fork DBs, boots each app on its own, wires the loopback port map, and asserts the databases are
    // distinct (a group's fedGroupAccount is @unique per DB — a shared DB would alias appB's mirror to
    // appA's origin thread, so the cross-server round-trip would never actually be exercised).
    ({ appA, appB } = await bootFederationPair());
    await truncateFederationDbs(appA, appB);

    // Seed alice @ appA. Tokens are minted DIRECTLY via AuthService.login (not the /auth/login HTTP route):
    // the two apps share one Node process, and Passport's `local` strategy is a process-global singleton,
    // so appB's registration (booted last) overwrites appA's — appA's /auth/login would be served by
    // appB's AuthService (reading appB's DB, where alice doesn't exist). The federation endpoints under
    // test use JWT auth (stateless, no Passport registry), so a directly-minted per-app JWT exercises them
    // exactly as a real login would. /auth/login itself is covered by auth.e2e-spec.ts (single app).
    const regA = await request(appA.app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'alice', name: 'Alice', password: 'Pass1234' });
    aliceLocalIdA = regA.body.data.id;
    tokenA = (await appA.app.get(AuthService).login(aliceLocalIdA)).access_token;

    // Seed bob @ appB (same direct-mint pattern).
    const regB = await request(appB.app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'bob', name: 'Bob', password: 'Pass1234' });
    const bobLocalIdB = regB.body.data.id;
    tokenB = (await appB.app.get(AuthService).login(bobLocalIdB)).access_token;

    // Avatars are TEST FIXTURES (alice's profile must carry a real base64 over S2S; bob's must exist so
    // alice's resolve localizes a real avatar). Set them via the internal service methods directly —
    // NOT via the HTTP /user/update-avatar route, which is a separate concern (multipart upload) not
    // under test here. Valid PNGs generated via sharp (saveAvatars' decode needs a real image header).
    const uploadA = appA.app.get(UploadService);
    const userSvcA = appA.app.get(UserService);
    const uploadB = appB.app.get(UploadService);
    const userSvcB = appB.app.get(UserService);
    await userSvcA.updateAvatar(
      aliceLocalIdA,
      await uploadA.saveAvatars(await makePng(220)),
    );
    png2 = await makePng(40); // second avatar for the re-pull test (distinct bytes → distinct file)
    await userSvcB.updateAvatar(
      bobLocalIdB,
      await uploadB.saveAvatars(await makePng(100)),
    );
  }, 60_000);

  afterAll(async () => {
    await appA?.app.close();
    await appB?.app.close();
  });

  it('init handshake establishes mutual trust on resolve', async () => {
    // alice@appA resolves bob@bbb.local → triggers ensurePeerTrusted(bbb.local) → mutual init.
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.isForeigner).toBe(true);
    expect(res.body.data.domain).toBe(DOM_B);
    bobStubIdOnA = res.body.data.id;

    // appA now trusts bbb.local.
    const peerA = await appA.prisma.federatedPeer.findUnique({
      where: { domain: DOM_B },
    });
    expect(peerA?.trustLevel).toBe('trusted');
    // appB auto-accepted the init → trusts aaa.local (mutual).
    const peerB = await appB.prisma.federatedPeer.findUnique({
      where: { domain: DOM_A },
    });
    expect(peerB?.trustLevel).toBe('trusted');
  });

  it('friend.request carries the profile and localizes the avatar on the receiver', async () => {
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ toUserId: bobStubIdOnA, note: 'hi from aaa' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appB created a stub of alice with a localized avatar (saved through saveAvatars → /uploads/).
    const aliceStubB = await appB.prisma.user.findUnique({
      where: { account_domain: { account: 'alice', domain: DOM_A } },
    });
    expect(aliceStubB).not.toBeNull();
    expect(aliceStubB!.isForeigner).toBe(true);
    expect(aliceStubB!.avatar).toMatch(/^\/uploads\/.+-(512)\.webp$/);
    aliceStubIdOnB = aliceStubB!.id;

    // appB has a PENDING FRIEND Invite from alice's stub (the S2S delivery created it + armed the badge).
    const inviteB = await appB.prisma.invite.findFirst({
      where: { kind: 'FRIEND', status: 'PENDING', fromUserId: aliceStubIdOnB },
    });
    expect(inviteB).not.toBeNull();
    expect(inviteB!.toUserId).not.toBe(aliceStubIdOnB); // addressed to bob (local), not the stub
  });

  it('friend.approve (no profile) creates the P2P thread on both servers', async () => {
    // appB accepts the inbound invite from alice's stub by its id.
    const inv = await appB.prisma.invite.findFirst({
      where: { kind: 'FRIEND', status: 'PENDING', fromUserId: aliceStubIdOnB },
    });
    expect(inv).not.toBeNull();
    const res = await request(appB.app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ inviteId: inv!.id.toString() });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appB (approver side): invite ACCEPTED + an active P2P thread with alice's stub.
    const invB = await appB.prisma.invite.findFirst({
      where: { kind: 'FRIEND', fromUserId: aliceStubIdOnB },
    });
    expect(invB?.status).toBe('ACCEPTED');
    const threadB = await appB.prisma.threadParticipant.findFirst({
      where: { userId: aliceStubIdOnB, leftAt: null, thread: { type: 'P2P' } },
      select: { threadId: true },
    });
    expect(threadB).not.toBeNull();

    // appA (requester side): received friend.approve → its own P2P thread + outgoing invite ACCEPTED.
    const invA = await appA.prisma.invite.findFirst({
      where: { kind: 'FRIEND', fromUserId: aliceLocalIdA, toUserId: bobStubIdOnA },
    });
    expect(invA?.status).toBe('ACCEPTED');
    const threadA = await appA.prisma.threadParticipant.findFirst({
      where: { userId: bobStubIdOnA, leftAt: null, thread: { type: 'P2P' } },
      select: { threadId: true },
    });
    expect(threadA).not.toBeNull();

    // appA's stub of bob also has a localized avatar (pulled at resolve time, pre-request).
    const bobStubA = await appA.prisma.user.findUnique({
      where: { id: bobStubIdOnA },
    });
    expect(bobStubA?.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
  });

  // ─── Step 2: cross-server 1:1 messages + media ───────────────────────────────
  // alice@appA ↔ bob@appB are now APPROVED with a P2P thread on each server. These exercise the
  // coalesced hint-map push → active-pull pipeline: a send marks the outbound map dirty → a debounced
  // /new-msg-map push → the peer drains pendingPulls → /messages pull → idempotent store + SSE.

  /** Resolve alice's P2P thread on appA (the thread she sends into). A friend relationship == a
   *  shared active P2P thread, so look it up via the bob stub's active participant row. */
  async function alicesThreadIdOnA(): Promise<number> {
    const p = await appA.prisma.threadParticipant.findFirst({
      where: { userId: bobStubIdOnA, leftAt: null, thread: { type: 'P2P' } },
      select: { threadId: true },
    });
    if (!p?.threadId) throw new Error('alice↔bob thread missing on appA');
    return p.threadId;
  }

  it('Step 2: a federated message is pushed + pulled to the peer (text) + SSE-fanned', async () => {
    const sse = appB.app.get(SseService);
    const spy = vi.spyOn(sse, 'onNewMessage');
    try {
      const res = await request(appA.app.getHttpServer())
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          threadId: await alicesThreadIdOnA(),
          content: 'hi from alice',
          contentType: 'PURE_TEXT',
        });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(BusinessCode.OK);
      // The ~500ms debounce pushes the hint; appB drains + pulls + stores + SSE. Poll for it.
      await vi.waitFor(
        async () => {
          const msg = await appB.prisma.message.findFirst({
            where: { content: 'hi from alice', creator: aliceStubIdOnB },
          });
          expect(msg).not.toBeNull();
          expect(msg!.originSeq).toBe(0); // alice's first message → originSeq 0 (0-indexed), copied verbatim
        },
        { timeout: 5000 },
      );
      // SSE delivered the rendered message body to bob (the local recipient on appB).
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('Step 2: pull-on-open is idempotent (a re-sync stores no duplicate)', async () => {
    const before = await appB.prisma.message.count({
      where: { creator: aliceStubIdOnB },
    });
    // sync-peer-profile triggers pull-on-open (§4.4) — fire-and-forget; the originSeq unique index
    // absorbs the re-pull as a no-op (the message is already at the cursor).
    await request(appB.app.getHttpServer())
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    // Let the async pull settle, then assert nothing duplicated.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await appB.prisma.message.count({
      where: { creator: aliceStubIdOnB },
    });
    expect(after).toBe(before);
  });

  it('Step 2: pull-on-open recovers a message missing on the peer (resilience backstop)', async () => {
    // alice sends; the push delivers it to appB (stored under alice's STUB as the creator — appB's own
    // copy in its own thread, distinct from appA's copy in appA's thread, even though both apps share
    // the per-fork test database).
    await request(appA.app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content: 'recover me',
        contentType: 'PURE_TEXT',
      });
    await vi.waitFor(
      async () => {
        expect(
          await appB.prisma.message.findFirst({
            where: { content: 'recover me', creator: aliceStubIdOnB },
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );
    // Simulate a message appB never stored (a lost push / a store that failed after the pull): wipe ONLY
    // appB's copy — scoped by creator so appA's own copy (creator = alice's local id) survives to be
    // re-pulled. The cursor (MAX originSeq for alice's stub on appB) drops, so pull-on-open sees the gap.
    await appB.prisma.message.deleteMany({
      where: { content: 'recover me', creator: aliceStubIdOnB },
    });
    expect(
      await appB.prisma.message.findFirst({
        where: { content: 'recover me', creator: aliceStubIdOnB },
      }),
    ).toBeNull();

    // bob opens the thread → pull-on-open re-derives the cursor + re-fetches the gap from appA — the
    // §4.4 backstop that makes a lost push non-fatal.
    await request(appB.app.getHttpServer())
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    await vi.waitFor(
      async () => {
        expect(
          await appB.prisma.message.findFirst({
            where: { content: 'recover me', creator: aliceStubIdOnB },
          }),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it('Step 2: a federated image localizes on the peer (media round-trip, same-origin)', async () => {
    // alice uploads an image on appA (fixture) → a CAS url. Sent as an IMAGE message whose content
    // embeds the url (the shape extractDigestEntries scans for the digest + ext).
    const uploadA = appA.app.get(UploadService);
    const { url, size } = await uploadA.save('image/png', await makePng(77));
    const digest = /([0-9a-f]{64})\./.exec(url)![1];
    const content = JSON.stringify({ url, w: 16, h: 16, size });
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content,
        contentType: 'IMAGE',
      });
    expect(res.status).toBe(200);

    // The message pulls, then localizeMedia fetches the digest via /get_file + stores it in appB's CAS
    // (byte-identical → same shard path) + writes the MediaMessage authz row. Poll for both.
    await vi.waitFor(
      async () => {
        const asset = await appB.prisma.mediaAsset.findUnique({
          where: { digest },
        });
        expect(asset).not.toBeNull();
        expect(asset!.refs).toBeGreaterThan(0);
        const mm = await appB.prisma.mediaMessage.findFirst({
          where: { digest },
        });
        expect(mm).not.toBeNull();
      },
      { timeout: 5000 },
    );
    // The localized file exists on appB's disk at the SAME server-relative path → renders same-origin.
    const { stat } = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      process.cwd(),
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    await expect(stat(abs)).resolves.toBeDefined();
  });

  it('Step 2: a federated file localizes over multiple Range chunks (resumable transport)', async () => {
    // A 48x48 PNG spans several 64-byte chunks (chunk size forced small in beforeAll) — proves the
    // receiver fetches /get_file as a sequence of signed Range GETs, not one whole-file buffer.
    const uploadA = appA.app.get(UploadService);
    const { url, size } = await uploadA.save(
      'image/png',
      await makePng(77, 48),
    );
    const digest = /([0-9a-f]{64})\./.exec(url)![1];
    // The two apps share one fork DB + one uploads/ dir, so appA's save() created the MediaAsset row
    // that appB's localizeMedia dedup would hit (skipping the wire fetch). Delete it to FORCE appB to
    // pull the bytes over /get_file — resolveMediaFile serves from the shard FILE + MediaMessage (not
    // MediaAsset), so appA still serves fine with the row gone. This simulates appB being separate.
    await appA.prisma.mediaAsset.delete({ where: { digest } }).catch(() => {});
    const content = JSON.stringify({ url, w: 48, h: 48, size });

    // Stub global fetch BEFORE send so every receiver /get_file call is counted. vi.stubGlobal (NOT
    // vi.spyOn — Node's `fetch` is non-writable on globalThis, so spyOn silently no-ops). Count by
    // pathname so the assertion doesn't depend on header inspection. supertest uses node:http, not
    // fetch, so the send-message call is unaffected.
    const realFetch = globalThis.fetch;
    let getfileReqs = 0;
    vi.stubGlobal(
      'fetch',
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const u =
          input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input.url);
        if (u.pathname.endsWith('/s2s/get_file')) getfileReqs++;
        return realFetch(input, init);
      },
    );

    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content,
        contentType: 'IMAGE',
      });
    expect(res.status).toBe(200);

    await vi.waitFor(
      async () => {
        const asset = await appB.prisma.mediaAsset.findUnique({
          where: { digest },
        });
        expect(asset).not.toBeNull();
        expect(asset!.refs).toBeGreaterThan(0);
        const mm = await appB.prisma.mediaMessage.findFirst({
          where: { digest },
        });
        expect(mm).not.toBeNull();
      },
      { timeout: 5000 },
    );
    vi.unstubAllGlobals();

    expect(getfileReqs).toBeGreaterThan(1); // multi-chunk path exercised (>1 /get_file call)

    // Integrity: the localized file re-hashes to the advertised digest (byte-exact, no gap/dup).
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      process.cwd(),
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    const onDisk = await readFile(abs);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);
    expect(onDisk.length).toBe(size);
  });

  it('Step 2: a dropped /get_file chunk resumes from its offset (no demote, byte-exact)', async () => {
    const uploadA = appA.app.get(UploadService);
    const { url, size } = await uploadA.save(
      'image/png',
      await makePng(190, 48),
    );
    const digest = /([0-9a-f]{64})\./.exec(url)![1];
    // Same shared-DB/disk dedup defeat as the multi-chunk test above — delete appA's MediaAsset row so
    // appB is forced to fetch over /get_file (appA still serves from the shard file + MediaMessage).
    await appA.prisma.mediaAsset.delete({ where: { digest } }).catch(() => {});
    const content = JSON.stringify({ url, w: 48, h: 48, size });

    // Spy: on the FIRST `bytes=0-` Range GET, proxy to the real peer then TRUNCATE the body mid-stream
    // (enqueue one piece, then error). The receiver already has the 206 headers, so it must treat this
    // as a mid-body stall — retry the SAME range (resume), NOT demote the peer.
    const realFetch = globalThis.fetch;
    let firstAborted = false;
    let firstOffsetRetry = 0;
    vi.stubGlobal(
      'fetch',
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const u =
          input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input.url);
        const h = init?.headers;
        const range =
          h instanceof Headers
            ? h.get('range')
            : Array.isArray(h) || typeof h === 'string'
              ? undefined
              : (h?.range ?? h?.Range);
        if (
          u.pathname.endsWith('/s2s/get_file') &&
          typeof range === 'string' &&
          range.startsWith('bytes=0-')
        ) {
          if (!firstAborted) {
            firstAborted = true;
            const realRes = await realFetch(input, init);
            const reader = (
              realRes.body as ReadableStream<Uint8Array>
            ).getReader();
            const first = await reader.read();
            await reader.cancel('simulated mid-stream abort');
            const truncated = new ReadableStream<Uint8Array>({
              start(ctl) {
                if (!first.done && first.value) ctl.enqueue(first.value);
                ctl.error(new Error('simulated mid-stream abort'));
              },
            });
            return new Response(truncated, {
              status: 206,
              headers: realRes.headers,
            });
          }
          firstOffsetRetry++; // the SAME `bytes=0-...` re-issued after the abort → resume happened
        }
        return realFetch(input, init);
      },
    );

    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        threadId: await alicesThreadIdOnA(),
        content,
        contentType: 'IMAGE',
      });
    expect(res.status).toBe(200);

    await vi.waitFor(
      async () => {
        const asset = await appB.prisma.mediaAsset.findUnique({
          where: { digest },
        });
        expect(asset).not.toBeNull();
        expect(asset!.refs).toBeGreaterThan(0);
      },
      { timeout: 8000 },
    );
    vi.unstubAllGlobals();

    expect(firstOffsetRetry).toBeGreaterThanOrEqual(1); // resume happened
    // A mid-body stall is a stream glitch, not a trust failure → the peer must still be trusted.
    const peer = await appB.prisma.federatedPeer.findUnique({
      where: { domain: DOM_A },
    });
    expect(peer?.trustLevel).toBe('trusted');

    // Integrity: the resumed file re-hashes to the digest (no gap/duplicate from the abort + retry).
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const nodePath = await import('node:path');
    const abs = nodePath.join(
      process.cwd(),
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
      nodePath.basename(url),
    );
    const onDisk = await readFile(abs);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);
    expect(onDisk.length).toBe(size);
  });

  it('/revision probe re-pulls a changed avatar', async () => {
    const before = await appB.prisma.user.findUnique({
      where: { id: aliceStubIdOnB },
    });
    expect(before?.remoteUpdatedAt).not.toBeNull();
    const avatarBefore = before!.avatar;

    // alice changes her avatar on appA → User.updatedAt bumps. Direct service call (fixture, not under test).
    const uploadA = appA.app.get(UploadService);
    const userSvcA = appA.app.get(UserService);
    await userSvcA.updateAvatar(aliceLocalIdA, await uploadA.saveAvatars(png2));

    // bob@appB opens the chat → sync-peer-profile probes /revision → newer → re-pull + re-localize.
    const sync = await request(appB.app.getHttpServer())
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    expect(sync.status).toBe(200);
    expect(sync.body.code).toBe(BusinessCode.OK);

    const after = await appB.prisma.user.findUnique({
      where: { id: aliceStubIdOnB },
    });
    expect(after!.avatar).not.toBe(avatarBefore);
    expect(after!.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
    expect(after!.remoteUpdatedAt?.getTime()).toBeGreaterThanOrEqual(
      before!.remoteUpdatedAt!.getTime(),
    );
  });

  it('sync-peer-profile short-circuits (data:null) when sinceUpdatedAt is fresh', async () => {
    const stub = await appB.prisma.user.findUnique({
      where: { id: aliceStubIdOnB },
      select: { updatedAt: true },
    });
    expect(stub).not.toBeNull();
    const fresh = stub!.updatedAt.getTime();

    // Caller already holds this exact revision → server returns data:null (no payload, no churn).
    const sameRev = await request(appB.app.getHttpServer())
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB, sinceUpdatedAt: fresh });
    expect(sameRev.status).toBe(200);
    expect(sameRev.body.code).toBe(BusinessCode.OK);
    expect(sameRev.body.data).toBeNull();

    // A cursor older than the live row → full user returned with a ms updatedAt.
    const pulled = await request(appB.app.getHttpServer())
      .post('/api/v1/user/sync-peer-profile')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB, sinceUpdatedAt: fresh - 1 });
    expect(pulled.status).toBe(200);
    expect(pulled.body.code).toBe(BusinessCode.OK);
    expect(pulled.body.data).not.toBeNull();
    expect(pulled.body.data.id).toBe(aliceStubIdOnB);
    expect(pulled.body.data.updatedAt).toBe(fresh);
  });

  it('local profile edit fans PEER_PROFILE_UPDATED to every approved peer', async () => {
    // alice (@appA) edits her name → the controller fires notifyPeersOfProfileUpdate → each approved
    // peer receives the FULL fresh profile via SseService.onPeerProfileUpdated. alice's only approved
    // peer on appA is bob's stub. The fan-out is fire-and-forget, so wait for it to land.
    const sse = appA.app.get(SseService);
    const spy = vi.spyOn(sse, 'onPeerProfileUpdated');
    try {
      const res = await request(appA.app.getHttpServer())
        .post('/api/v1/user/update-profile')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Alice Renamed' });
      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(
          bobStubIdOnA,
          expect.objectContaining({ id: aliceLocalIdA, name: 'Alice Renamed' }),
        );
      });
      // Pushed payload is the full profile (avatar path + ms updatedAt), not a partial patch.
      const call = spy.mock.calls.find((c) => c[0] === bobStubIdOnA);
      expect(call).toBeDefined();
      const payload = call![1] as { updatedAt?: number; avatar?: string };
      expect(typeof payload.updatedAt).toBe('number');
      expect(payload.avatar).toMatch(/^\/uploads\//);
    } finally {
      spy.mockRestore();
    }
  });

  it("federated re-localization fans PEER_PROFILE_UPDATED to the stub's local friends (catch-up)", async () => {
    // bob (@appB) is the local friend of the alice stub on appB. When the stub is re-localized (alice
    // changes her avatar on appA, then bob@appB's sync-peer-profile probes + re-localizes), the stub's
    // local friends get the push without each probing independently — the only way federated peers
    // benefit from the push (no S2S profile-push; federation is pull-based).
    const bobLocal = await appB.prisma.user.findUnique({
      where: { account_domain: { account: 'bob', domain: 'local' } },
      select: { id: true },
    });
    expect(bobLocal).not.toBeNull();

    // Stale the stub again (distinct avatar bytes → a newer revision on appA).
    const uploadA = appA.app.get(UploadService);
    const userSvcA = appA.app.get(UserService);
    await userSvcA.updateAvatar(
      aliceLocalIdA,
      await uploadA.saveAvatars(await makePng(180)),
    );

    const sse = appB.app.get(SseService);
    const spy = vi.spyOn(sse, 'onPeerProfileUpdated');
    try {
      await request(appB.app.getHttpServer())
        .post('/api/v1/user/sync-peer-profile')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ userId: aliceStubIdOnB });
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(
          bobLocal!.id,
          expect.objectContaining({ id: aliceStubIdOnB, isForeigner: true }),
        );
      });
    } finally {
      spy.mockRestore();
    }
  });

  // ─── Step 3 Phase B: cross-server group messaging (origin-hub) ────────────────
  it('Step 3: federated group — invite → accept → origin-hub message delivery', async () => {
    // alice@appA creates a group and invites bob@appB (a federated friend). writeInvites sends the
    // cross-server invite (peer mints the mirror + Invite) AND writes the GROUP_INVITE card into alice's
    // P2P mirror (it flows to bob via the Step-2 pull). The card + the accept key on the group `!account`.
    const create = await request(appA.app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'fed-group', inviteUserIds: [bobStubIdOnA] });
    expect(create.status).toBe(200);
    expect(create.body.code).toBe(BusinessCode.OK);
    const groupThreadA = create.body.data.threadId as number;

    // The group account (fedGroupAccount == the group !account) — the on-wire group address.
    const trdA = await appA.prisma.messageThread.findUnique({
      where: { id: groupThreadA },
      select: { fedGroupAccount: true, originDomain: true },
    });
    expect(trdA?.fedGroupAccount).toBeTruthy();
    expect(trdA?.originDomain).toBe(DOM_A); // appA is the origin
    const groupAccount = trdA!.fedGroupAccount as string;

    // appB mints the mirror + the incoming Invite (handleGroupInvite). Poll for the mirror thread.
    const mirrorB = await vi.waitFor(
      async () => {
        const m = await appB.prisma.messageThread.findUnique({
          where: { fedGroupAccount: groupAccount },
          select: { id: true, originDomain: true },
        });
        expect(m).not.toBeNull();
        expect(m!.originDomain).toBe(DOM_A); // mirror knows the origin
        return m!;
      },
      { timeout: 5000 },
    );

    // bob accepts via the group account (the federated-stable card identity). appB's acceptInvite
    // resolves the pending Invite by (toUser=bob, thread.fedGroupAccount) + notifies the origin.
    const accept = await request(appB.app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ inviteId: groupAccount });
    expect(accept.status).toBe(200);
    expect([BusinessCode.OK, BusinessCode.FEDERATION_DELIVERY_FAILED]).toContain(accept.body.code);

    // The origin (appA) records bob on its canonical roster (handleGroupAccept). Poll for it.
    await vi.waitFor(
      async () => {
        const bobOnA = await appA.prisma.threadParticipant.findUnique({
          where: { userId_threadId: { userId: bobStubIdOnA, threadId: groupThreadA } },
          select: { leftAt: true },
        });
        expect(bobOnA?.leftAt).toBeNull(); // bob is an active member on the origin roster
      },
      { timeout: 5000 },
    );

    // alice (origin local member) sends a group message → appB mirror pulls it from the origin hub.
    const sse = appB.app.get(SseService);
    const spy = vi.spyOn(sse, 'onNewMessage');
    try {
      const send = await request(appA.app.getHttpServer())
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ threadId: groupThreadA, content: 'hello group', contentType: 'PURE_TEXT' });
      expect(send.status).toBe(200);
      expect(send.body.code).toBe(BusinessCode.OK);
      // The message lands on bob's mirror (origin-hub: appA is the origin, signals appB; appB pulls).
      // Assert BOTH the stored row AND the SSE delivery to bob (a local member of the mirror) — polled so
      // a small async gap between the pull-store and the SSE fan never flakes the assertion.
      await vi.waitFor(
        async () => {
          const msg = await appB.prisma.message.findFirst({
            where: { threadId: mirrorB.id, content: 'hello group' },
          });
          expect(msg).not.toBeNull();
          expect(spy).toHaveBeenCalled();
        },
        { timeout: 8000 },
      );
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('Step 3: the GROUP invite carries sinceSeq = the origin curSeq (the invite-time latest)', async () => {
    // sinceSeq seeds the invitee's pullUntil so a new member starts from invite-time, not the full
    // pre-join history. This test pins the SENDER side: the invite body carries sinceSeq = the origin's
    // curSeq at invite time (-1 for a fresh group; the curSeq after a pre-invite message). The receiver
    // seeds pullUntil from it in findOrCreateMirrorThread (covered by code review; the cross-server mirror
    // creation can't be exercised here because the two-app harness shares ONE database, so appB's mirror
    // aliases appA's origin thread on the @unique fedGroupAccount — see the harness note at the top).
    const create = await request(appA.app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'fed-group-seq', inviteUserIds: [] }); // bob invited separately below
    expect(create.body.code).toBe(BusinessCode.OK);
    const groupThreadA = create.body.data.threadId as number;

    // A pre-invite message advances the origin curSeq to 0 BEFORE the invite ⇒ sinceSeq should be 0.
    const pre = await request(appA.app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId: groupThreadA, content: 'before-bob-joined', contentType: 'PURE_TEXT' });
    expect(pre.body.code).toBe(BusinessCode.OK);
    const curSeqBefore = (
      await appA.prisma.messageThread.findUnique({ where: { id: groupThreadA }, select: { curSeq: true } })
    )!.curSeq;

    // Spy on the receiver so we can inspect the wire body of the inbound GROUP invite.
    const fedB = appB.app.get(FederationService);
    const spy = vi.spyOn(fedB, 'handleInvite');
    try {
      const invite = await request(appA.app.getHttpServer())
        .post('/api/v1/group/invite')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ groupId: groupThreadA, userIds: [bobStubIdOnA] });
      expect(invite.body.code).toBe(BusinessCode.OK);

      const groupBody = spy.mock.calls
        .map((c) => c[0])
        .find((b) => b?.kind === 'GROUP') as { sinceSeq?: number } | undefined;
      expect(groupBody).toBeTruthy();
      // sinceSeq mirrors the origin curSeq at invite time (the pre-invite message made it 0). A fresh
      // group with no messages would carry sinceSeq = -1 (the curSeq default).
      expect(groupBody!.sinceSeq).toBe(curSeqBefore);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('unfriend is local-only (no S2S fan-out; peer learns lazily)', async () => {
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userId: bobStubIdOnA });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appA tore it down — the P2P thread is soft-left (no active thread between alice and bob's stub).
    const threadA = await appA.prisma.threadParticipant.findFirst({
      where: { userId: bobStubIdOnA, leftAt: null, thread: { type: 'P2P' } },
      select: { threadId: true },
    });
    expect(threadA).toBeNull();

    // appB is UNCHANGED — no S2S notification was sent. The active P2P thread still stands; appB only
    // learns lazily about the severance (Step 2 send-reject, resolveFriendshipThread → 403).
    const threadB = await appB.prisma.threadParticipant.findFirst({
      where: { userId: aliceStubIdOnB, leftAt: null, thread: { type: 'P2P' } },
      select: { threadId: true },
    });
    expect(threadB).not.toBeNull();
  });

  it('rejects an inbound invite signed by an untrusted domain', async () => {
    // evil.local: a real Ed25519 key, but never init'd → not in FederatedPeer.
    const evilPriv = ed25519.utils.randomSecretKey();
    const evilKeypair = {
      getKeyId: () => `${DOM_A}-evil/key-1`, // signer domain = "aaa.local-evil" → not trusted
      getPrivateKey: () => evilPriv,
      getPublicKeyB64: () =>
        Buffer.from(ed25519.getPublicKey(evilPriv)).toString('base64'),
    };
    const evilSig = new SignatureService(evilKeypair as never);
    const authority = `127.0.0.1:${appA.port}`;
    const body = JSON.stringify({
      id: '01TEST00000000000000000000',
      origin: `${DOM_A}-evil`,
      kind: 'FRIEND',
      from: { account: 'mallory', domain: `${DOM_A}-evil` },
      to: { account: 'x', domain: `${DOM_A}-evil` },
      ts: 0,
    });
    const headers = evilSig.signOutbound({
      method: 'POST',
      path: '/api/v1/s2s/invite',
      authority,
      body,
    });

    const res = await fetch(`http://${authority}/api/v1/s2s/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe(BusinessCode.FEDERATION_PEER_NOT_TRUSTED);
  });

  // ─── trust lifecycle: demote on failure → re-handshake → block ───────────────────────────────
  // These run after the friend-flow tests; aaa↔bbb are still mutually trusted (unfriending above is
  // local-only and does not demote). They drive the state machine through real signed S2S traffic:
  // a dead loopback URL forces a network failure → markDemoted; restoring it → ensurePeerTrusted
  // re-handshakes → markTrusted; markBlocked → resolve surfaces FEDERATION_PEER_BLOCKED.

  it('demotes a trusted peer when a signed op fails (network), logs the event + purges keys', async () => {
    // Precondition: aaa still trusts bbb, and bbb's signing keys are cached on aaa (fetched at init).
    const peerBefore = await appA.prisma.federatedPeer.findUnique({
      where: { domain: DOM_B },
    });
    expect(peerBefore?.trustLevel).toBe('trusted');
    const keysBefore = await appA.prisma.s2SKeyCache.findMany({
      where: { domain: DOM_B },
    });
    expect(keysBefore.length).toBeGreaterThan(0);

    // Point bbb's loopback base at a dead port → the resolve's signed GET refuses the connection.
    const liveB = TestDiscoveryService.portMap[DOM_B];
    TestDiscoveryService.portMap[DOM_B] = 'http://127.0.0.1:1';

    // alice@appA resolves bob@bbb.local again. ensurePeerTrusted short-circuits (trusted), then
    // fetchRemoteUser fails (ECONNREFUSED) → markDemoted(DOM_B) → resolve surfaces DELIVERY_FAILED.
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.FEDERATION_DELIVERY_FAILED);

    // aaa demoted bbb: state flipped, count bumped, demoted event logged, keys purged.
    const peerAfter = await appA.prisma.federatedPeer.findUnique({
      where: { domain: DOM_B },
    });
    expect(peerAfter?.trustLevel).toBe('demoted');
    expect(peerAfter?.demotionCount).toBe(1);
    expect(peerAfter?.demotedAt).not.toBeNull();
    expect(peerAfter?.demoteReason).toContain('network/timeout');

    const demotedEvent = await appA.prisma.federatedPeerEvent.findFirst({
      where: { domain: DOM_B, type: 'demoted' },
    });
    expect(demotedEvent).not.toBeNull();
    expect(demotedEvent!.reason).toContain('network/timeout');

    const keysAfter = await appA.prisma.s2SKeyCache.findMany({
      where: { domain: DOM_B },
    });
    expect(keysAfter.length).toBe(0);

    // Restore bbb's live loopback URL for the re-handshake test below.
    TestDiscoveryService.portMap[DOM_B] = liveB;
  });

  it('re-handshakes a demoted peer back to trusted on the next resolve (self-healing)', async () => {
    // alice@appA resolves bob@bbb.local once more → ensurePeerTrusted sees `demoted` → re-runs the init
    // handshake → markTrusted flips back to trusted + logs a `trusted` event AFTER the demoted one.
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    const peer = await appA.prisma.federatedPeer.findUnique({
      where: { domain: DOM_B },
    });
    expect(peer?.trustLevel).toBe('trusted');
    expect(peer?.demotedAt).toBeNull();
    expect(peer?.demoteReason).toBeNull();

    // peerEvents is newest-first, so the most recent transition is types[0] — after a re-handshake
    // that must be `trusted` (trust re-established), and the timeline still contains the earlier demote.
    const events = await appA.app.get(FederationService).peerEvents(DOM_B, 50);
    const types = (events as { type: string; createdAt: string }[]).map(
      (e) => e.type,
    );
    expect(types[0]).toBe('trusted');
    expect(types).toContain('demoted');
  });

  it('blocks a peer: resolve fails fast with FEDERATION_PEER_BLOCKED + admin reads work', async () => {
    const fedA = appA.app.get(FederationService);

    // Admin blocks bbb on appA (the persistent control). Then resolve must NOT attempt a handshake —
    // it surfaces FEDERATION_PEER_BLOCKED (distinct from an unreachable peer).
    await fedA.markBlocked(DOM_B, 'abuse');
    const blocked = await appA.prisma.federatedPeer.findUnique({
      where: { domain: DOM_B },
    });
    expect(blocked?.trustLevel).toBe('blocked');

    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ account: 'bob', domain: DOM_B });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.FEDERATION_PEER_BLOCKED);

    // Admin reads (the admin page's data sources): the list filters by state, the timeline (newest-first)
    // carries the full discovered → trusted → demoted → trusted → blocked process, with blocked on top.
    const list = await fedA.listPeers({ skip: 0, take: 10, status: 'blocked' });
    expect(
      (list as { list: { domain: string }[] }).list.some(
        (p) => p.domain === DOM_B,
      ),
    ).toBe(true);

    const tl = (await fedA.peerEvents(DOM_B, 50)) as { type: string }[];
    const types = tl.map((e) => e.type);
    expect(types).toContain('discovered');
    expect(types).toContain('demoted');
    expect(types[0]).toBe('blocked');
  });
});
