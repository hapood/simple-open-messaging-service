import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bootFederationApp,
  makeInMemoryKeypair,
  makePng,
  TestDiscoveryService,
  truncateFederationTables,
  type BootedApp,
} from './federation-harness.js';
import { BusinessCode } from '../src/common/business-code.js';
import { SignatureService } from '../src/federation/signature.service.js';
import { UploadService } from '../src/upload/upload.service.js';
import { UserService } from '../src/user/user.service.js';

/**
 * Federation e2e — two full SOMS apps (aaa.local + bbb.local) in one process, making real signed HTTP
 * requests to each other over loopback. Exercises the full S2S chain: signOutbound → fetch → Fastify
 * preParsing raw-body capture → content-digest + signature verify → init handshake → friend flows →
 * avatar localization → /revision staleness probe. See the harness header for the loopback trick.
 */

const DOM_A = 'aaa.local';
const DOM_B = 'bbb.local';

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
    // Boot appA (aaa.local) then appB (bbb.local). Env is set per-boot inside bootFederationApp.
    const keyA = makeInMemoryKeypair(DOM_A);
    const keyB = makeInMemoryKeypair(DOM_B);
    appA = await bootFederationApp({ domain: DOM_A, keypair: keyA });
    appB = await bootFederationApp({ domain: DOM_B, keypair: keyB });

    // Late-bind the loopback map now that both ports are known.
    TestDiscoveryService.portMap = {
      [DOM_A]: `http://127.0.0.1:${appA.port}`,
      [DOM_B]: `http://127.0.0.1:${appB.port}`,
    };

    await truncateFederationTables(appA.prisma);

    // Seed alice @ appA.
    await request(appA.app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ uniqName: 'alice', password: 'Pass1234' });
    const loginA = await request(appA.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ uniqName: 'alice', password: 'Pass1234' });
    tokenA = loginA.body.data.access_token;
    const aProfile = await request(appA.app.getHttpServer())
      .post('/api/v1/user/my-profile')
      .set('Authorization', `Bearer ${tokenA}`);
    aliceLocalIdA = aProfile.body.data.id;

    // Seed bob @ appB.
    await request(appB.app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ uniqName: 'bob', password: 'Pass1234' });
    const loginB = await request(appB.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ uniqName: 'bob', password: 'Pass1234' });
    tokenB = loginB.body.data.access_token;
    const bProfile = await request(appB.app.getHttpServer())
      .post('/api/v1/user/my-profile')
      .set('Authorization', `Bearer ${tokenB}`);
    const bobLocalIdB = bProfile.body.data.id;

    // Avatars are TEST FIXTURES (alice's profile must carry a real base64 over S2S; bob's must exist so
    // alice's resolve localizes a real avatar). Set them via the internal service methods directly —
    // NOT via the HTTP /user/update-avatar route, which is a separate concern (multipart upload) not
    // under test here. Valid PNGs generated via sharp (saveAvatars' decode needs a real image header).
    const uploadA = appA.app.get(UploadService);
    const userSvcA = appA.app.get(UserService);
    const uploadB = appB.app.get(UploadService);
    const userSvcB = appB.app.get(UserService);
    await userSvcA.updateAvatar(aliceLocalIdA, await uploadA.saveAvatars(await makePng(220)));
    png2 = await makePng(40); // second avatar for the re-pull test (distinct bytes → distinct file)
    await userSvcB.updateAvatar(bobLocalIdB, await uploadB.saveAvatars(await makePng(100)));
  }, 60_000);

  afterAll(async () => {
    await appA?.app.close();
    await appB?.app.close();
  });

  it('init handshake establishes mutual trust on resolve', async () => {
    // alice@appA resolves bob@bbb.local → triggers ensurePeerTrusted(bbb.local) → mutual init.
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/by-uniq-name')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ uniqName: `bob@${DOM_B}` });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.isForeigner).toBe(true);
    expect(res.body.data.domain).toBe(DOM_B);
    bobStubIdOnA = res.body.data.id;

    // appA now trusts bbb.local.
    const peerA = await appA.prisma.federatedPeer.findUnique({ where: { domain: DOM_B } });
    expect(peerA?.trustLevel).toBe('trusted');
    // appB auto-accepted the init → trusts aaa.local (mutual).
    const peerB = await appB.prisma.federatedPeer.findUnique({ where: { domain: DOM_A } });
    expect(peerB?.trustLevel).toBe('trusted');
  });

  it('friend.request carries the profile and localizes the avatar on the receiver', async () => {
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/send-friend-request')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userId: bobStubIdOnA, message: 'hi from aaa' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appB created a stub of alice with a localized avatar (saved through saveAvatars → /uploads/).
    const aliceStubB = await appB.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: 'alice', domain: DOM_A } },
    });
    expect(aliceStubB).not.toBeNull();
    expect(aliceStubB!.isForeigner).toBe(true);
    expect(aliceStubB!.avatar).toMatch(/^\/uploads\/.+-(512)\.webp$/);
    aliceStubIdOnB = aliceStubB!.id;

    // appB has a PENDING friendship, requester = alice's stub.
    const friendshipB = await appB.prisma.friendship.findFirst({
      where: { OR: [{ userAId: aliceStubIdOnB }, { userBId: aliceStubIdOnB }] },
    });
    expect(friendshipB?.status).toBe('PENDING');
    expect(friendshipB?.requesterId).toBe(aliceStubIdOnB);
  });

  it('friend.approve (no profile) creates the P2P thread on both servers', async () => {
    const res = await request(appB.app.getHttpServer())
      .post('/api/v1/user/approve-friend-request')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ userId: aliceStubIdOnB });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appB (approver side): APPROVED + a thread.
    const fB = await appB.prisma.friendship.findFirst({
      where: { OR: [{ userAId: aliceStubIdOnB }, { userBId: aliceStubIdOnB }] },
    });
    expect(fB?.status).toBe('APPROVED');
    expect(fB?.threadId).not.toBeNull();

    // appA (requester side): received friend.approve → its own P2P thread + APPROVED.
    const fA = await appA.prisma.friendship.findFirst({
      where: { OR: [{ userAId: bobStubIdOnA }, { userBId: bobStubIdOnA }] },
    });
    expect(fA?.status).toBe('APPROVED');
    expect(fA?.threadId).not.toBeNull();

    // appA's stub of bob also has a localized avatar (pulled at resolve time, pre-request).
    const bobStubA = await appA.prisma.user.findUnique({
      where: { id: bobStubIdOnA },
    });
    expect(bobStubA?.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
  });

  it('/revision probe re-pulls a changed avatar', async () => {
    const before = await appB.prisma.user.findUnique({ where: { id: aliceStubIdOnB } });
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

    const after = await appB.prisma.user.findUnique({ where: { id: aliceStubIdOnB } });
    expect(after!.avatar).not.toBe(avatarBefore);
    expect(after!.avatar).toMatch(/^\/uploads\/.+-512\.webp$/);
    expect(after!.remoteUpdatedAt?.getTime()).toBeGreaterThanOrEqual(before!.remoteUpdatedAt!.getTime());
  });

  it('unfriend is local-only (no S2S fan-out; peer learns lazily)', async () => {
    const res = await request(appA.app.getHttpServer())
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ userId: bobStubIdOnA });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);

    // appA tore it down.
    const fA = await appA.prisma.friendship.findFirst({
      where: { OR: [{ userAId: bobStubIdOnA }, { userBId: bobStubIdOnA }] },
    });
    expect(fA?.status).toBe('DELETED');

    // appB is UNCHANGED — no friend.delete envelope was sent. It only learns lazily (Step 2 send-reject).
    const fB = await appB.prisma.friendship.findFirst({
      where: { OR: [{ userAId: aliceStubIdOnB }, { userBId: aliceStubIdOnB }] },
    });
    expect(fB?.status).toBe('APPROVED');
  });

  it('rejects an inbound envelope signed by an untrusted domain', async () => {
    // evil.local: a real Ed25519 key, but never init'd → not in FederatedPeer.
    const evilPriv = ed25519.utils.randomSecretKey();
    const evilKeypair = {
      getKeyId: () => `${DOM_A}-evil/key-1`, // signer domain = "aaa.local-evil" → not trusted
      getPrivateKey: () => evilPriv,
      getPublicKeyB64: () => Buffer.from(ed25519.getPublicKey(evilPriv)).toString('base64'),
    };
    const evilSig = new SignatureService(evilKeypair as never);
    const authority = `127.0.0.1:${appA.port}`;
    const body = JSON.stringify({ type: 'friend.request', from: "mallory@aaa.local-evil", to: [] });
    const headers = evilSig.signOutbound({
      method: 'POST',
      path: '/api/v1/s2s/inbox',
      authority,
      body,
    });

    const res = await fetch(`http://${authority}/api/v1/s2s/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe(BusinessCode.FEDERATION_PEER_NOT_TRUSTED);
  });
});
