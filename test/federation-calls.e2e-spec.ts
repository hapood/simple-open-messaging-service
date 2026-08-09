import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import request from 'supertest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  bootFederationPair,
  truncateFederationDbs,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  registerAndLogin,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers.js';
import { BusinessCode } from '../src/common/business-code.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  friendRequest,
  message,
  threadParticipant,
  user,
} from '../src/database/schema.js';

/**
 * Federated 1:1 call e2e — a SELF-CONTAINED two-server suite (own bootFederationPair + own DBs + a
 * fresh friend pair erin@appA / frank@appB). Kept separate from test/federation.e2e-spec.ts so the
 * call scenarios run in clean trust + a live P2P edge (the main suite's late tests block/demote the
 * peer + sever edges, which would make `initiate` return CALL_NOT_ALLOWED).
 *
 * Validates the full cross-server relay: initiate → S2S `incoming` → appB mirror + ring → accept →
 * S2S `accepted` → appA → end/decline → the ORIGIN (appA) authors the CALL bubble → appB PULLS it via
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
  let frankStubIdOnA: number; // appA's stub of frank (foreign) — the `calleeUserId` erin dials
  let erinStubIdOnB: number; // appB's stub of erin (foreign) — the bubble's creator on the pulled copy

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    await truncateFederationDbs(appA, appB);
    ({ token: tokenErin } = await registerAndLogin(appA, 'erin', 'Erin'));
    ({ token: tokenFrank } = await registerAndLogin(appB, 'frank', 'Frank'));

    // Mutual trust: erin resolves frank → triggers the init handshake (auto-accept both ways).
    const res = await request(appA.baseUrl)
      .post('/api/v1/user/resolve')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({ account: 'frank', domain: DOM_B });
    expect(res.body.code).toBe(BusinessCode.OK);
    frankStubIdOnA = res.body.data.id;

    // erin invites frank → appB creates erin's stub + a PENDING FRIEND invite for frank.
    const inv = await request(appA.baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${tokenErin}`)
      .send({ toUserId: frankStubIdOnA, note: 'hi' });
    expect(inv.body.code).toBe(BusinessCode.OK);
    const erinStubB = await vi.waitFor(
      async () => {
        const stub = await appB.database.query.user.findFirst({
          where: and(eq(user.account, 'erin'), eq(user.domain, DOM_A)),
        });
        expect(stub).toBeDefined();
        return stub!;
      },
      { timeout: 10_000, interval: 100 },
    );
    erinStubIdOnB = erinStubB.id;

    // frank accepts → a live P2P thread exists on BOTH servers.
    const pending = await vi.waitFor(
      async () => {
        const request = await appB.database.query.friendRequest.findFirst({
          where: and(
            eq(friendRequest.status, 'REQUESTED'),
            eq(friendRequest.requesterUserId, erinStubIdOnB),
          ),
        });
        expect(request).toBeDefined();
        return request!;
      },
      { timeout: 10_000, interval: 100 },
    );
    const acc = await request(appB.baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${tokenFrank}`)
      .send({ inviteId: pending.id.toString() });
    expect(acc.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(
      async () => {
        const activeOnA =
          await appA.database.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, frankStubIdOnA),
              isNull(threadParticipant.leftAt),
            ),
          });
        expect(activeOnA).toBeDefined();
      },
      { timeout: 10_000, interval: 100 },
    );
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

  it('ring → accept → connected → end → completed bubble authored on appA + pulled to appB', async () => {
    const callSid = randomUUID();
    // Frank's SSE must be open BEFORE the ring to capture the incoming CALL_EVENT.
    const frankSse = await openSse(appB.baseUrl, tokenFrank);
    const erinSse = await openSse(appA.baseUrl, tokenErin);
    try {
      const incomingP = waitCallEvent(frankSse, 'incoming', callSid);
      const initRes = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, calleeUserId: frankStubIdOnA, callType: 'AUDIO' });
      expect(initRes.body.code).toBe(BusinessCode.OK);
      await incomingP; // the ring crossed S2S → appB mirrored + rang frank

      // Erin's SSE gets `accepted` (callee answered / negotiating — NOT connected yet).
      const acceptedP = waitCallEvent(erinSse, 'accepted', callSid);
      const accRes = await request(appB.baseUrl)
        .post('/api/v1/calls/accept')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      expect(accRes.body.code).toBe(BusinessCode.OK);
      await acceptedP;

      // The media leg connects (either client reports) → `connected` is the real startedAt authority.
      const connectedP = waitCallEvent(erinSse, 'connected', callSid);
      const connRes = await request(appB.baseUrl)
        .post('/api/v1/calls/connected')
        .set('Authorization', `Bearer ${tokenFrank}`)
        .send({ callSid });
      expect(connRes.body.code).toBe(BusinessCode.OK);
      await connectedP;

      // Erin ends → the ORIGIN (appA) authors the terminal `completed` bubble synchronously.
      const endRes = await request(appA.baseUrl)
        .post('/api/v1/calls/end')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, endReason: 'completed' });
      expect(endRes.body.code).toBe(BusinessCode.OK);

      const onA = await pollFor(() =>
        appA.database.query.message.findFirst({
          where: eq(message.clientMessageId, callSid),
        }),
      );
      expect(onA.contentType).toBe('CALL');
      const content = JSON.parse(onA.content);
      expect(content.status).toBe('completed');
      expect(content.startedAt).toBeTypeOf('number'); // connected stamped a real connect time
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
        .send({ callSid, calleeUserId: frankStubIdOnA, callType: 'AUDIO' });
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
          where: eq(message.clientMessageId, callSid),
        }),
      );
    } finally {
      await frankSse.cancel();
      await erinSse.cancel();
    }
  }, 30_000);

  it('callee declines cross-server → declined bubble authored on appA (origin) + pulled to appB', async () => {
    const callSid = randomUUID();
    const frankSse = await openSse(appB.baseUrl, tokenFrank);
    try {
      const incomingP = waitCallEvent(frankSse, 'incoming', callSid);
      const initRes = await request(appA.baseUrl)
        .post('/api/v1/calls/initiate')
        .set('Authorization', `Bearer ${tokenErin}`)
        .send({ callSid, calleeUserId: frankStubIdOnA, callType: 'VIDEO' });
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
          where: eq(message.clientMessageId, callSid),
        }),
      );
      expect(onA.contentType).toBe('CALL');
      expect(JSON.parse(onA.content).status).toBe('declined');

      // The bubble pulls to appB — find frank's P2P thread with erin's stub, then the CALL row by originSeq.
      const frankThreadB =
        await appB.database.query.threadParticipant.findFirst({
          where: and(
            eq(threadParticipant.userId, erinStubIdOnB),
            isNull(threadParticipant.leftAt),
            sql`exists (select 1 from "MessageThread" mt where mt.id = "threadParticipant"."threadId" and mt.type = ${MessageThreadType.P2P})`,
          ),
          columns: { threadId: true },
        });
      const onB = await pollFor(() =>
        appB.database.query.message.findFirst({
          where: and(
            eq(message.threadId, frankThreadB!.threadId),
            eq(message.creator, erinStubIdOnB),
            eq(message.originSeq, onA.originSeq),
            eq(message.contentType, 'CALL'),
          ),
        }),
      );
      expect(JSON.parse(onB.content).status).toBe('declined');
    } finally {
      await frankSse.cancel();
    }
  }, 30_000);
});
