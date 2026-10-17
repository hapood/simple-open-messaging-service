import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  registerAndLogin,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers.js';
import { BusinessCode } from '../src/common/business-code.js';
import {
  identityNamespace,
  message,
  account as user,
} from '../src/database/schema.js';

/**
 * Federated 1:1 call e2e — a SELF-CONTAINED two-server suite (own bootFederationPair + own DBs + a
 * fresh friend pair erin@appA / frank@appB). Kept separate from test/federation.e2e-spec.ts so the
 * call scenarios run in clean trust + a live P2P edge (the main suite's late tests halt/degrade the
 * peer + sever edges, which would make `initiate` return CALL_NOT_ALLOWED).
 *
 * Validates the full cross-server relay: initiate → S2S `incoming` → appB mirror + ring → accept →
 * S2S `accepted` → appA → end/decline → each server authors its own terminal system notice via
 * the message sync. Timer-based outcomes (missed / safety-net) are slow + flaky in e2e and are covered
 * by the unit spec's fake timers.
 */
const DOM_A = FED_DOMAIN_A;
const DOM_B = FED_DOMAIN_B;

describe('Federated 1:1 calls e2e (two nodes, real signed S2S call relay)', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let tokenErin: string;
  let tokenFrank: string;
  let frankId: number;
  let erinThreadId: number;
  let frankThreadId: number;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    ({ token: tokenErin } = await registerAndLogin(appA, 'erin', 'Erin'));
    ({ id: frankId, token: tokenFrank } = await registerAndLogin(
      appB,
      'frank',
      'Frank',
    ));

    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: (await appA.database.query.account.findFirst({
        where: and(eq(user.account, 'erin'), eq(user.namespaceId, 0)),
      }))!.id,
      remoteUserId: (await appB.database.query.account.findFirst({
        where: and(eq(user.account, 'frank'), eq(user.namespaceId, 0)),
      }))!.id,
      localToken: tokenErin,
      remoteToken: tokenFrank,
      localAccount: 'erin',
      remoteAccount: 'frank',
      localDomain: DOM_A,
      remoteDomain: DOM_B,
      note: 'hi',
    });
    erinThreadId = friendship.localThreadId;
    frankThreadId = friendship.remoteThreadId;
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  /** Poll a predicate until it returns non-null or the timeout elapses (the S2S relay + the debounced
   *  message pull are asynchronous, so terminal frames + pulled bubbles land slightly after the HTTP 200). */
  async function pollFor<T>(
    fn: () => Promise<T | null | undefined>,
    timeoutMs = 5000,
  ): Promise<T> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await fn();
      if (r) return r;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`pollFor timed out after ${timeoutMs}ms`);
  }

  /** Wait for a CALL_EVENT of `type` for `callSid` on the given SSE stream. */
  const waitCallEvent = (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    type: string,
    callSid: string,
  ) =>
    waitForSseEvent(
      reader,
      (ev, d) =>
        ev === 'CALL_EVENT' &&
        (d as { type?: string; callSid?: string } | null)?.type === type &&
        (d as { callSid?: string }).callSid === callSid,
    );

  it('ring → connect → AUDIO-to-VIDEO upgrade → completed VIDEO bubble', async () => {
    const callSid = randomUUID();
    // Frank's SSE must be open BEFORE the ring to capture the incoming CALL_EVENT.
    const frankSse = await openSse(appB.baseUrl, tokenFrank);
    const erinSse = await openSse(appA.baseUrl, tokenErin);
    try {
      const incomingP = waitCallEvent(frankSse, 'incoming', callSid);
      const initRes = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, threadId: erinThreadId, callType: 'AUDIO' });
      expect(initRes.body.code).toBe(BusinessCode.OK);
      await incomingP; // the ring crossed S2S → appB mirrored + rang frank

      // Real offer relay over S2S, including the receiver-local peer id.
      const offerId = randomUUID();
      const offer = await request(appA.baseUrl)
        .post('/api/v1/calls/signal')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({
          id: offerId,
          callSid,
          kind: 'offer',
          payload: 'OFFER_SDP',
        });
      expect(offer.body.code).toBe(BusinessCode.OK);
      await pollFor(async () => {
        const staged = await request(appB.baseUrl)
          .get(`/api/v1/calls/${callSid}/signaling`)
          .set('Authorization', `Bearer ${tokenFrank}`);
        return staged.body.data?.offer?.payload === 'OFFER_SDP'
          ? staged.body.data
          : null;
      });

      // Erin's SSE gets `accepted` (callee answered / negotiating — NOT connected yet).
      const acceptedP = waitCallEvent(erinSse, 'accepted', callSid);
      const accRes = await request(appB.baseUrl)
        .post('/api/v1/calls/accept')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      expect(accRes.body.code).toBe(BusinessCode.OK);
      await acceptedP;

      const answer = await request(appB.baseUrl)
        .post('/api/v1/calls/signal')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({
          id: randomUUID(),
          callSid,
          kind: 'answer',
          inReplyTo: offerId,
          payload: 'ANSWER_SDP',
        });
      expect(answer.body.code).toBe(BusinessCode.OK);
      await pollFor(async () => {
        const staged = await request(appA.baseUrl)
          .get(`/api/v1/calls/${callSid}/signaling`)
          .set('Authorization', `Bearer ${tokenErin}`);
        return staged.body.data?.answer?.payload === 'ANSWER_SDP' &&
          staged.body.data.answer.inReplyTo === offerId
          ? staged.body.data
          : null;
      });

      // The callee endpoint confirms media-up; each server records its local connection time.
      const connectedP = waitCallEvent(erinSse, 'connected', callSid);
      const connRes = await request(appB.baseUrl)
        .post('/api/v1/calls/connected')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      expect(connRes.body.code).toBe(BusinessCode.OK);
      await connectedP;

      // After caller-authored renegotiation succeeds, the caller server is the sole video-upgraded
      // authority; Frank observes the signed lifecycle frame without creating a second call.
      const upgradedP = waitCallEvent(frankSse, 'video-upgraded', callSid);
      const upgradeRes = await request(appA.baseUrl)
        .post('/api/v1/calls/upgrade-video')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid });
      expect(upgradeRes.body.code).toBe(BusinessCode.OK);
      await upgradedP;

      // Erin ends → the ORIGIN (appA) authors the terminal `completed` bubble synchronously.
      const endRes = await request(appA.baseUrl)
        .post('/api/v1/calls/end')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, endReason: 'completed' });
      expect(endRes.body.code).toBe(BusinessCode.OK);

      const onA = await pollFor(() =>
        appA.database.query.message.findFirst({
          where: sql`${message.content}->>'callId' = ${callSid}`,
        }),
      );
      expect(onA.contentType).toBe('SYSTEM');
      const content = JSON.parse(onA.content);
      expect(content.outcome).toBe('completed');
      expect(content.mediaType).toBe('VIDEO');
      expect(content.connectedAt).toBeTypeOf('number'); // connected stamped a real connect time
    } finally {
      await frankSse.cancel();
      await erinSse.cancel();
    }
  }, 30_000);

  it('callee `/calls/ringing` relays an S2S `ringing` frame → erin (caller) sees CALL_EVENT{ringing}', async () => {
    const callSid = randomUUID();
    const frankSse = await openSse(appB.baseUrl, tokenFrank);
    const erinSse = await openSse(appA.baseUrl, tokenErin);
    try {
      const incomingP = waitCallEvent(frankSse, 'incoming', callSid);
      const initRes = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, threadId: erinThreadId, callType: 'AUDIO' });
      expect(initRes.body.code).toBe(BusinessCode.OK);
      await incomingP;

      // Frank's device acks it is ringing → the mirror relays `ringing` to the origin → erin sees it.
      const ringingP = waitCallEvent(erinSse, 'ringing', callSid);
      const ringRes = await request(appB.baseUrl)
        .post('/api/v1/calls/ringing')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      expect(ringRes.body.code).toBe(BusinessCode.OK);
      await ringingP;

      // Clean up: frank declines on appB (the MIRROR). The mirror frees its busy slot synchronously; the
      // ORIGIN (appA) frees asynchronously when its inbound `declined` handler runs — which is also when it
      // authors the `declined` bubble. Polling for that bubble is the deterministic signal appA has released
      // erin's slot, so the next test's erin-initiate doesn't trip CALL_BUSY (a bare await on the HTTP 200
      // would race the cross-server relay).
      await request(appB.baseUrl)
        .post('/api/v1/calls/decline')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      await pollFor(() =>
        appA.database.query.message.findFirst({
          where: sql`${message.content}->>'callId' = ${callSid}`,
        }),
      );
    } finally {
      await frankSse.cancel();
      await erinSse.cancel();
    }
  }, 30_000);

  it('returns CALL_BUSY to a second caller when the remote callee is already ringing', async () => {
    const { id: carolId, token: tokenCarol } = await registerAndLogin(
      appA,
      'call-carol',
      'Carol',
    );
    const friendship = await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: carolId,
      remoteUserId: frankId,
      localToken: tokenCarol,
      remoteToken: tokenFrank,
      localAccount: 'call-carol',
      remoteAccount: 'frank',
      localDomain: DOM_A,
      remoteDomain: DOM_B,
      note: 'hi',
    });
    const firstSid = randomUUID();
    const busySid = randomUUID();
    const frankSse = await openSse(appB.baseUrl, tokenFrank);
    try {
      const incomingP = waitCallEvent(frankSse, 'incoming', firstSid);
      const first = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid: firstSid, threadId: erinThreadId, callType: 'AUDIO' });
      expect(first.body.code).toBe(BusinessCode.OK);
      await incomingP;
      const localBusy = await request(appB.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({
          callSid: randomUUID(),
          threadId: frankThreadId,
          callType: 'AUDIO',
        });
      expect(localBusy.body.code).toBe(BusinessCode.CALL_BUSY);

      const busy = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenCarol}`)
        .send({
          callSid: busySid,
          threadId: friendship.localThreadId,
          callType: 'AUDIO',
        });
      expect(busy.status).toBe(200);
      expect(busy.body.code).toBe(BusinessCode.CALL_BUSY);
      const notice = await pollFor(() =>
        appA.database.query.message.findFirst({
          where: sql`${message.content}->>'callId' = ${busySid}`,
        }),
      );
      expect(JSON.parse(notice.content).outcome).toBe('unreachable');
      // The callee's existing ring must remain active, and a failed admission creates no remote call.
      const rejectedCall = await request(appB.baseUrl)
        .get(`/api/v1/calls/${busySid}/signaling`)
        .set('Authorization', `Bearer ${tokenFrank}`);
      expect(rejectedCall.body.code).toBe(BusinessCode.CALL_NOT_FOUND);
      expect(
        await appB.database.query.message.findFirst({
          where: sql`${message.content}->>'callId' = ${busySid}`,
        }),
      ).toBeUndefined();
    } finally {
      await request(appA.baseUrl)
        .post('/api/v1/calls/cancel')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid: firstSid });
      await frankSse.cancel();
      await pollFor(() =>
        appB.database.query.message.findFirst({
          where: sql`${message.content}->>'callId' = ${firstSid}`,
        }),
      );
    }
  }, 30_000);

  it('callee declines cross-server → each server commits its own local system notice', async () => {
    const callSid = randomUUID();
    const frankSse = await openSse(appB.baseUrl, tokenFrank);
    try {
      const incomingP = waitCallEvent(frankSse, 'incoming', callSid);
      const initRes = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, threadId: erinThreadId, callType: 'VIDEO' });
      expect(initRes.body.code).toBe(BusinessCode.OK);
      await incomingP;

      // Frank declines → appB sends a `declined` frame → appA (origin) authors the bubble on the inbound frame.
      const decRes = await request(appB.baseUrl)
        .post('/api/v1/calls/decline')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      expect(decRes.body.code).toBe(BusinessCode.OK);

      const onA = await pollFor(() =>
        appA.database.query.message.findFirst({
          where: sql`${message.content}->>'callId' = ${callSid}`,
        }),
      );
      expect(onA.contentType).toBe('SYSTEM');
      expect(JSON.parse(onA.content).outcome).toBe('declined');

      // Frank's server commits its own notice from the terminal fact.
      const onB = await pollFor(() =>
        appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, frankThreadId),
            sql`${message.content}->>'callId' = ${callSid}`,
            eq(message.contentType, 'SYSTEM'),
          ),
        }),
      );
      const erinHomeOnB = await appB.database.query.identityNamespace.findFirst(
        {
          where: and(
            eq(identityNamespace.domain, DOM_A),
            eq(identityNamespace.active, true),
          ),
        },
      );
      expect(erinHomeOnB).toBeDefined();
      expect(JSON.parse(onB.content)).toMatchObject({
        outcome: 'declined',
        type: 'CALL_ENDED',
        caller: {
          account: 'erin',
          publisherNamespaceId: erinHomeOnB!.id,
          profileNamespaceId: 0,
          profileRev: 0,
        },
        callee: {
          account: 'frank',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          profileRev: 0,
        },
      });
    } finally {
      await frankSse.cancel();
    }
  }, 30_000);
});
