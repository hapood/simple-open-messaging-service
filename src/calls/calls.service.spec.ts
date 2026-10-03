// Unit tests for CallsService — the in-memory live state machine, bilateral lifecycle fan-out,
// terminal system-notice persistence, signaling relay, and the ringing-timeout backstop. The deps
// (store, SSE, push, participants, CallHistoryService) are mocked; the service is
// instantiated directly (the codebase's unit-spec convention).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CallsService } from './calls.service.js';
import { callTombstoneCache } from './call-tombstone-cache.js';
import { CallStateRegistry } from '../gateway/call-state.registry.js';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from '../federation/federation-errors.js';
import { parseCallEndedContent } from '../../shared/call-ended-content.js';
import type { CallOutcome } from '../../shared/call-ended-content.js';
import type {
  S2SCallFrame,
  S2SAddress,
} from '../federation/federation.service.js';

vi.mock('../federation/federation.config.js', () => ({
  loadFederationConfig: () => ({ domain: 'local.test' }),
}));

vi.mock('../relationship/shared/relationship-authorization.js', () => ({
  isThreadMutuallyAuthorized: async (db: { authorized: boolean }) =>
    db.authorized,
}));

function mkMocks() {
  return {
    database: {
      db: {
        authorized: true,
        query: {
          account: {
            findFirst: vi.fn().mockImplementation(({ where }) => {
              const address = new PgDialect().sqlToQuery(where).params[0];
              return Promise.resolve({
                id:
                  typeof address === 'string'
                    ? Number(address.replace('user', ''))
                    : address,
                account: 'alice',
                domain: 'local',
                namespaceId: 0,
                name: 'Alice',
                avatar: 'a.webp',
              });
            }),
          },
        },
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ callSid: 'cs1' }]),
            })),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          })),
        })),
      },
    },
    sse: { onCallEvent: vi.fn(), onCallSignal: vi.fn() },
    push: { dispatchForCall: vi.fn().mockResolvedValue(undefined) },
    participants: {
      findP2PPeers: vi.fn().mockImplementation(async ([threadId]: number[]) => [
        {
          threadId,
          account: `user${threadId - 8}`,
          domain: 'local',
          namespaceId: 0,
          name: 'Alice',
          avatar: 'a.webp',
          profileRev: 1,
        },
      ]),
    },
    history: {
      observe: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    },
    federation: { sendCallFrame: vi.fn().mockResolvedValue(undefined) },
    quota: {
      tick: vi.fn().mockResolvedValue(undefined),
      peek: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function mkService(m = mkMocks()) {
  callTombstoneCache.clear();
  const callState = new CallStateRegistry();
  return {
    svc: new CallsService(
      m.database as never,
      m.sse as never,
      m.push as never,
      m.participants as never,
      m.federation as never,
      m.quota as never,
      callState,
      m.history as never,
    ),
    m,
    callState,
  };
}

/** Recipients (userIds) a CALL_EVENT was fanned to. */
function eventRecipients(m: ReturnType<typeof mkMocks>): number[] {
  return m.sse.onCallEvent.mock.calls.map((c) => c[0] as number);
}

/** The BusinessCode carried by a thrown BusinessException. */
function bizCode(e: unknown): number {
  return (e as { bizCode?: number }).bizCode ?? -1;
}

/** The parsed terminal system content of the LAST terminal bubble write (null if none / unparseable). */
function lastBubbleContent(m: ReturnType<typeof mkMocks>) {
  const call = m.history.finish.mock.calls.at(-1);
  if (!call) return null;
  return parseCallEndedContent(
    JSON.stringify((call[0] as { content: unknown }).content),
  );
}

describe('CallsService.initiate', () => {
  it('registers a live ringing call, rings the callee in-band (SSE) + to all devices (push)', async () => {
    const { svc, m } = mkService();
    const res = await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    expect(res).toEqual({ callSid: 'cs1', threadId: 10 });
    // Ring: SSE to callee (with caller display info) + push to the callee's devices.
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'incoming',
        callerUserId: 1,
        callerName: 'Alice',
        callType: 'AUDIO',
      }),
    );
    expect(m.push.dispatchForCall).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        callSid: 'cs1',
        callerUserId: 1,
        callType: 'AUDIO',
      }),
    );
    // No terminal bubble yet — the call is live.
    expect(m.history.finish).not.toHaveBeenCalled();
  });

  it('does not acknowledge a retry before local admission is durable', async () => {
    const { svc, m } = mkService();
    let commit!: () => void;
    m.history.observe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
    );
    const first = svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await vi.waitFor(() => expect(m.history.observe).toHaveBeenCalledOnce());
    let replied = false;
    const retry = svc
      .initiate(1, { callSid: 'cs1', threadId: 10, callType: 'AUDIO' })
      .then(() => {
        replied = true;
      });
    await Promise.resolve();
    expect(replied).toBe(false);
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
    commit();
    await Promise.all([first, retry]);
    expect(m.history.observe).toHaveBeenCalledOnce();
  });

  it('refuses calling yourself', async () => {
    const { svc } = mkService();
    await expect(
      svc.initiate(1, { callSid: 'cs1', threadId: 9, callType: 'AUDIO' }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_ALLOWED,
    );
  });

  it('dedupes a retried endpoint signal ID before staging or fan-out', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    const signal = {
      id: 'signal-retry',
      callSid: 'cs1',
      kind: 'offer' as const,
      payload: 'OFFER_SDP',
    };

    await svc.signal(1, signal);
    await svc.signal(1, signal);

    expect(m.sse.onCallSignal).toHaveBeenCalledTimes(1);
    expect(svc.signaling(2, 'cs1')).toEqual({
      offer: { id: 'signal-retry', payload: 'OFFER_SDP' },
      ice: [],
    });
  });

  it('refuses a non-friend callee (no P2P thread)', async () => {
    const { svc, m } = mkService();
    m.database.db.authorized = false;
    await expect(
      svc.initiate(1, { callSid: 'cs1', threadId: 10, callType: 'AUDIO' }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_ALLOWED,
    );
  });

  it('rejects when the caller is already in an active call (busy)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    }); // caller 1 now busy
    await expect(
      svc.initiate(1, { callSid: 'cs2', threadId: 11, callType: 'AUDIO' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY);
  });

  it('rejects when the callee is already in an active call (busy)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    }); // callee 2 now busy
    await expect(
      svc.initiate(3, { callSid: 'cs2', threadId: 10, callType: 'AUDIO' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY);
  });

  it('glare: two CONCURRENT initiates (A→B + B→A) — exactly one wins, the other is CALL_BUSY (no TOCTOU)', async () => {
    // The busy-check + the activeByUser reservation must be one synchronous block (no await between), else
    // both initiates pass the check during each other's callee-fetch await + both register (glare). This
    // fires them concurrently via Promise.allSettled so their awaits interleave.
    const { svc } = mkService();
    const results = await Promise.allSettled([
      svc.initiate(1, { callSid: 'csAB', threadId: 10, callType: 'AUDIO' }),
      svc.initiate(2, { callSid: 'csBA', threadId: 9, callType: 'AUDIO' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(bizCode((rejected[0] as PromiseRejectedResult).reason)).toBe(
      BusinessCode.CALL_BUSY,
    );
  });

  it('is idempotent on callSid — a retry re-rings the still-ringing call, no new live call', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    m.sse.onCallEvent.mockClear();
    const res = await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    expect(res).toEqual({ callSid: 'cs1', threadId: 10 });
    expect(m.sse.onCallEvent).toHaveBeenCalled(); // re-rang
    // The caller is still in exactly one call: a brand-new callSid still trips busy on the caller.
    await expect(
      svc.initiate(1, { callSid: 'csX', threadId: 11, callType: 'AUDIO' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY);
  });
});

describe('CallsService bilateral lifecycle fan-out', () => {
  it('accept fans `accepted` to BOTH caller and callee (callee-other-devices dismiss ringing)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    m.sse.onCallEvent.mockClear();
    await svc.accept(2, 'cs1');
    const types = new Set(
      m.sse.onCallEvent.mock.calls.map((c) => (c[1] as { type: string }).type),
    );
    expect(types.has('accepted')).toBe(true);
    expect(eventRecipients(m).sort()).toEqual([1, 2]); // both
    // No push on accept (only the incoming ring pushes).
    expect(m.push.dispatchForCall).toHaveBeenCalledTimes(1); // the single ring from initiate
  });

  it('ringing ack fans `ringing` to BOTH, leaves the call ringing (no transition), and dedupes multi-device', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    m.sse.onCallEvent.mockClear();
    await svc.ringing(2, 'cs1');
    expect(
      new Set(
        m.sse.onCallEvent.mock.calls.map(
          (c) => (c[1] as { type: string }).type,
        ),
      ).has('ringing'),
    ).toBe(true);
    expect(eventRecipients(m).sort()).toEqual([1, 2]); // both
    // A second device's ack is an idempotent no-op (no second fan-out).
    m.sse.onCallEvent.mockClear();
    await svc.ringing(2, 'cs1');
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
    // `ringing` did NOT transition state — `accept` still succeeds (ringing → accepted).
    m.sse.onCallEvent.mockClear();
    await svc.accept(2, 'cs1');
    expect(
      new Set(
        m.sse.onCallEvent.mock.calls.map(
          (c) => (c[1] as { type: string }).type,
        ),
      ).has('accepted'),
    ).toBe(true);
  });

  it('decline / cancel / ended each fan to BOTH participants; incoming is callee-only; missed is caller-only', async () => {
    // incoming (from initiate) → callee only
    const a = mkService();
    await a.svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    const incoming = a.m.sse.onCallEvent.mock.calls
      .filter((c) => (c[1] as { type: string }).type === 'incoming')
      .map((c) => c[0]);
    expect(incoming).toEqual([2]);
    await a.svc.accept(2, 'cs1');
    a.m.sse.onCallEvent.mockClear();
    await a.svc.end(1, 'cs1', 'completed');
    // ended → both
    expect(eventRecipients(a.m).sort()).toEqual([1, 2]);

    // cancel → both
    const b = mkService();
    await b.svc.initiate(1, {
      callSid: 'cs2',
      threadId: 11,
      callType: 'AUDIO',
    });
    b.m.sse.onCallEvent.mockClear();
    await b.svc.cancel(1, 'cs2');
    expect(eventRecipients(b.m).sort()).toEqual([1, 3]);

    // decline → both
    const c = mkService();
    await c.svc.initiate(4, {
      callSid: 'cs3',
      threadId: 13,
      callType: 'VIDEO',
    });
    c.m.sse.onCallEvent.mockClear();
    await c.svc.decline(5, 'cs3');
    expect(eventRecipients(c.m).sort()).toEqual([4, 5]);
  });
});

describe('CallsService terminal bubble persistence', () => {
  it('decline writes a local CALL_ENDED system notice keyed by the call binding', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.decline(2, 'cs1');
    expect(m.history.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 10,
        content: expect.objectContaining({ callId: 'cs1' }),
      }),
    );
    expect(lastBubbleContent(m)).toMatchObject({
      type: 'CALL_ENDED',
      mediaType: 'AUDIO',
      outcome: 'declined',
    });
    // An unanswered call never connected → no startedAt/duration.
    const c = lastBubbleContent(m)!;
    expect(c.caller).toMatchObject({
      profileNamespaceId: 0,
      profileRev: 0,
    });
    expect(c.callee).toMatchObject({
      profileNamespaceId: 0,
      profileRev: 0,
    });
    expect(c.connectedAt).toBeUndefined();
    expect(
      c.connectedAt === undefined ? undefined : c.endedAt - c.connectedAt,
    ).toBeUndefined();
  });

  it('cancel writes a `cancelled` bubble', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.cancel(1, 'cs1');
    expect(lastBubbleContent(m)?.outcome).toBe('cancelled');
  });

  it('connected (media up) stamps startedAt; end → completed bubble WITH duration', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'VIDEO',
    });
    await svc.accept(2, 'cs1'); // answered — NOT connected yet (no startedAt)
    await svc.connected(2, 'cs1'); // callee confirms media up → startedAt stamped
    await svc.end(1, 'cs1', 'completed');
    const c = lastBubbleContent(m)!;
    expect(c).toMatchObject({
      outcome: 'completed',
      mediaType: 'VIDEO',
    });
    expect(c.connectedAt).toBeTypeOf('number');
    expect(
      c.connectedAt === undefined ? undefined : c.endedAt - c.connectedAt,
    ).toBeTypeOf('number');
    expect(c.endedAt).toBeTypeOf('number');
  });

  it('accept alone does NOT set startedAt — answered-but-never-connected end → failed (no duration)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1'); // answered, media never came up
    await svc.end(2, 'cs1');
    const c = lastBubbleContent(m)!;
    expect(c.outcome).toBe('failed'); // a connection failure
    expect(c.connectedAt).toBeUndefined(); // never really connected
    expect(
      c.connectedAt === undefined ? undefined : c.endedAt - c.connectedAt,
    ).toBeUndefined();
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'ended', endReason: 'failed' }),
    );
  });

  it('end with reason `failed` after connected → failed WITH duration (connected-then-failed)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1'); // connected
    await svc.end(2, 'cs1', 'failed');
    const c = lastBubbleContent(m)!;
    expect(c.outcome).toBe('failed');
    expect(c.connectedAt).toBeTypeOf('number'); // it HAD connected
  });

  it('a terminal transition releases both busy slots (the users can place a new call)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.cancel(1, 'cs1');
    // Both 1 and 2 are free again — a fresh call between them succeeds.
    await expect(
      svc.initiate(2, { callSid: 'cs2', threadId: 9, callType: 'AUDIO' }),
    ).resolves.toEqual({
      callSid: 'cs2',
      threadId: 9,
    });
  });
});

describe('CallsService.accept / decline / cancel / end guards', () => {
  it('accept by a non-callee is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(svc.accept(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('a repeated accept after acceptance is an idempotent no-op', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1'); // → accepted
    await expect(svc.accept(2, 'cs1')).resolves.toBeUndefined();
  });

  it('ringing by a non-callee is rejected; a historical ringing ack is a no-op', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(svc.ringing(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
    await svc.accept(2, 'cs1'); // → accepted (no longer ringing)
    await expect(svc.ringing(2, 'cs1')).resolves.toBeUndefined();
  });

  it('decline by a non-callee is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(svc.decline(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('cancel by a non-caller is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(svc.cancel(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('requires end rather than cancel after accepted', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await expect(svc.cancel(1, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_INVALID_TRANSITION,
    );
    await expect(svc.end(1, 'cs1')).resolves.toBeUndefined();
  });

  it('end on a ringing call is an invalid transition', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(svc.end(1, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_INVALID_TRANSITION,
    );
  });

  it('end by a non-participant is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await expect(svc.end(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('upgrades a connected audio call once and persists the terminal bubble as video', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1');
    m.sse.onCallEvent.mockClear();

    await svc.upgradeVideo(1, 'cs1');
    await svc.upgradeVideo(1, 'cs1');

    const upgraded = m.sse.onCallEvent.mock.calls.filter(
      ([, event]) => event.type === 'video-upgraded',
    );
    expect(upgraded).toHaveLength(2);
    expect(upgraded.map(([userId]) => userId).sort()).toEqual([1, 2]);

    await svc.end(1, 'cs1');
    expect(lastBubbleContent(m)).toMatchObject({
      mediaType: 'VIDEO',
      outcome: 'completed',
    });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'ended', endReason: 'completed' }),
    );
  });

  it('rejects video upgrade before media connects or from a non-participant', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await expect(svc.upgradeVideo(1, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_INVALID_TRANSITION,
    );
    await svc.connected(2, 'cs1');
    await expect(svc.upgradeVideo(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('decline / cancel are idempotent on an already-terminal call (no second bubble)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.decline(2, 'cs1');
    await svc.decline(2, 'cs1'); // already terminal → no-op
    expect(m.history.finish).toHaveBeenCalledTimes(1);
  });
});

describe('CallsService.signal (relay)', () => {
  it('relays a frame from a participant to the other participant over SSE', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await svc.signal(1, {
      id: 'signal-1',
      callSid: 'cs1',
      kind: 'ice',
      payload: '{"cand":1}',
    });
    expect(m.sse.onCallSignal).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        id: 'signal-1',
        callSid: 'cs1',
        fromUserId: 1,
        kind: 'ice',
        payload: '{"cand":1}',
      }),
    );
  });

  it('rejects a sender who is not a participant', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(
      svc.signal(99, {
        id: 'signal-1',
        callSid: 'cs1',
        kind: 'ice',
        payload: '{}',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('rejects a non-participant even when the call SID is known', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await expect(
      svc.signal(77, {
        id: 'signal-1',
        callSid: 'cs1',
        kind: 'ice',
        payload: '{}',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('rejects relaying on an unknown / no-longer-live callSid', async () => {
    const { svc } = mkService();
    await expect(
      svc.signal(1, {
        id: 'signal-1',
        callSid: 'nope',
        kind: 'ice',
        payload: '{}',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_FOUND,
    );
  });
});

describe('CallsService ringing timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips ringing → missed after the timeout, dismisses both sides, and writes the bubble', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    m.sse.onCallEvent.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    // Both sides (including sibling devices) must leave the live ringing UI.
    expect(eventRecipients(m).sort()).toEqual([1, 2]);
    expect(m.sse.onCallEvent.mock.calls[0][1]).toMatchObject({
      type: 'missed',
    });
    expect(lastBubbleContent(m)?.outcome).toBe('missed');
    // Slots released → caller can place a new call.
    await expect(
      svc.initiate(1, { callSid: 'cs2', threadId: 10, callType: 'AUDIO' }),
    ).resolves.toBeDefined();
  });

  it('does NOT time out after the media leg connected (the timer is disarmed on connected, not accept)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1'); // answered — the timer is STILL armed (media not yet up)
    await svc.connected(2, 'cs1'); // media up → timer disarmed
    m.history.finish.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    // Connected → no timeout terminal write fired.
    expect(m.history.finish).not.toHaveBeenCalled();
  });

  it('maps an accepted connect timeout to ended(timeout) for both local participants', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    m.sse.onCallEvent.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(eventRecipients(m).sort()).toEqual([1, 2]);
    for (const [, event] of m.sse.onCallEvent.mock.calls) {
      expect(event).toMatchObject({ type: 'ended', endReason: 'timeout' });
    }
    expect(lastBubbleContent(m)?.outcome).toBe('failed');
  });

  it('an answered-but-never-connected call times out → failed (a connection failure, NOT missed)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1'); // answered, media never comes up
    m.history.finish.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    // `accepted` at timeout → `failed` (the callee DID answer, so it is not `missed`).
    expect(lastBubbleContent(m)?.outcome).toBe('failed');
  });
});

/** Build an inbound S2SCallFrame (the wire shape FederationService resolves + emits on
 *  'call.frame.inbound'). Defaults describe S_B's server ringing OUR local user (alice@aaa.local).
 *  Overrides are loose (payload as a free record, callType allowed on any op) because several tests
 *  construct frames that are intentionally malformed — the service must reject them at runtime. */
function mkFrame(
  p: {
    op?: S2SCallFrame['op'];
    callType?: 'AUDIO' | 'VIDEO';
    payload?: Record<string, unknown>;
  } = {},
): S2SCallFrame {
  const op = p.op ?? 'incoming';
  const suppliedPayload = p.payload;
  return {
    callSid: 'cs1',
    op,
    ...(op === 'incoming' ? { callType: 'AUDIO' } : {}),
    ...p,
    ...(op === 'incoming'
      ? {
          payload: {
            fromAccount: 'bob',
            toAccount: 'alice',
            ...suppliedPayload,
          },
        }
      : {}),
    ...(op === 'signal' && suppliedPayload
      ? { payload: { signalId: 'signal-1', ...suppliedPayload } }
      : {}),
  } as S2SCallFrame;
}

/** Drive the inbound bridge (the @OnEvent handler) directly. */
function inbound(
  svc: CallsService,
  args: {
    localUserId: number;
    threadId?: number;
    peerDomain?: string;
    namespaceId?: number;
    signatureExpiresAtSec?: number;
    frame: S2SCallFrame;
  },
): Promise<void> {
  return svc.onInboundCallFrame({
    localUserId: args.localUserId,
    peerDomain: args.peerDomain ?? 'bbb.local',
    namespaceId: args.namespaceId ?? 3,
    threadId: args.threadId ?? 10,
    signatureExpiresAtSec:
      args.signatureExpiresAtSec ?? Math.floor(Date.now() / 1000) + 300,
    frame: args.frame,
  });
}

describe('CallsService federated initiate (outbound)', () => {
  it('does not reserve a foreign endpoint as a local account or expose it in HELLO', async () => {
    const { svc, m, callState } = mkService();
    m.participants.findP2PPeers.mockResolvedValueOnce([
      {
        threadId: 10,
        account: 'remote',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Remote',
        avatar: '',
        profileRev: 1,
      },
    ]);
    await svc.initiate(1, {
      callSid: 'foreign-call',
      threadId: 10,
      callType: 'AUDIO',
    });
    expect(callState.get(1)).toMatchObject({
      threadId: 10,
      peerUserId: null,
      peerAccount: 'remote',
      peerDomain: 'bbb.local',
    });
    expect(callState.get(2)).toBeNull();
    await expect(
      svc.initiate(2, {
        callSid: 'local-call',
        threadId: 11,
        callType: 'AUDIO',
      }),
    ).resolves.toMatchObject({ threadId: 11 });
    expect(callState.get(2)).toMatchObject({ peerUserId: 3 });
  });

  it('a foreign callee is rung over S2S and only the local caller owns a busy slot', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    const res = await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'VIDEO',
    });
    expect(res).toEqual({ callSid: 'cs1', threadId: 10 });
    expect(m.federation.sendCallFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'incoming',
        fromLocalUserId: 1,
        callType: 'VIDEO',
      }),
      'bbb.local',
    );
    expect(
      (m.federation.sendCallFrame.mock.calls[0][0] as { to: S2SAddress }).to,
    ).toEqual({ account: 'bob', domain: 'bbb.local' });
    // No local ring — the foreign callee is rung on its own server.
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
    expect(m.push.dispatchForCall).not.toHaveBeenCalled();
    // The local caller is busy; the foreign participant has no local busy slot.
    await expect(
      svc.initiate(1, { callSid: 'cs2', threadId: 11, callType: 'AUDIO' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY);
  });

  it('surfaces a remote busy admission result without cancelling the unadmitted peer call', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    m.federation.sendCallFrame.mockRejectedValueOnce(
      new S2sResponseError('busy', 200, BusinessCode.CALL_BUSY),
    );
    await expect(
      svc.initiate(1, {
        callSid: 'busy-remote',
        threadId: 10,
        callType: 'AUDIO',
      }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY);
    expect(lastBubbleContent(m)?.outcome).toBe('unreachable');
    expect(m.federation.sendCallFrame).toHaveBeenCalledOnce();
    m.federation.sendCallFrame.mockResolvedValue(undefined);
    await expect(
      svc.initiate(1, { callSid: 'retry', threadId: 10, callType: 'AUDIO' }),
    ).resolves.toBeDefined();
  });

  it('a ring failure writes an `unreachable` bubble + throws CALL_PEER_UNREACHABLE + releases slots', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    m.federation.sendCallFrame.mockRejectedValue(new Error('network down'));
    await expect(
      svc.initiate(1, { callSid: 'cs1', threadId: 10, callType: 'AUDIO' }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_PEER_UNREACHABLE,
    );
    expect(lastBubbleContent(m)?.outcome).toBe('unreachable');
    expect(lastBubbleContent(m)?.callee).toEqual({
      account: 'bob',
      domain: 'bbb.local',
      profileNamespaceId: 0,
      profileRev: 0,
    });
    // Slots released → a fresh call can start.
    m.federation.sendCallFrame.mockResolvedValue(undefined);
    await expect(
      svc.initiate(1, { callSid: 'csX', threadId: 10, callType: 'AUDIO' }),
    ).resolves.toBeDefined();
  });

  it('records confirmed non-delivery locally without sending cancellation', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    m.federation.sendCallFrame.mockRejectedValue(
      new Error('connect failed', { cause: { code: 'ECONNREFUSED' } }),
    );
    await expect(
      svc.initiate(1, { callSid: 'cs1', threadId: 10, callType: 'AUDIO' }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_PEER_UNREACHABLE,
    );
    expect(m.federation.sendCallFrame).toHaveBeenCalledOnce();
    expect(lastBubbleContent(m)?.outcome).toBe('unreachable');
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
  });

  it('sends cancelled when the caller ring safety timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const { svc, m } = mkService();
      m.participants.findP2PPeers.mockResolvedValue([
        {
          account: 'bob',
          domain: 'bbb.local',
          namespaceId: 3,
          name: 'Bob',
          avatar: '',
        },
      ]);
      await svc.initiate(1, {
        callSid: 'cs1',
        threadId: 10,
        callType: 'AUDIO',
      });
      m.federation.sendCallFrame.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(m.federation.sendCallFrame).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'cancelled', callSid: 'cs1' }),
        'bbb.local',
      );
      expect(lastBubbleContent(m)?.outcome).toBe('missed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends ended(timeout) when the callee connect timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const { svc, m } = mkService();
      await inbound(svc, {
        localUserId: 2,
        frame: mkFrame(),
      });
      await svc.accept(2, 'cs1');
      m.federation.sendCallFrame.mockClear();

      await vi.advanceTimersByTimeAsync(45_000);

      expect(m.federation.sendCallFrame).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'ended',
          callSid: 'cs1',
          endReason: 'timeout',
        }),
        'bbb.local',
      );
      expect(m.history.finish).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let the caller server author connected', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'accepted' }),
    });
    m.federation.sendCallFrame.mockClear();
    m.sse.onCallEvent.mockClear();

    await svc.connected(1, 'cs1');

    expect(m.federation.sendCallFrame).not.toHaveBeenCalled();
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
  });
});

describe('CallsService federated inbound (@OnEvent call.frame.inbound)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('incoming registers callee-side state, rings the local user, and ticks quota once', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'incoming', callerUserId: null }),
    );
    expect(m.push.dispatchForCall).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ callSid: 'cs1' }),
    );
    expect(m.quota.tick).toHaveBeenCalledWith(3, 'requests');
    expect(m.quota.tick).toHaveBeenCalledTimes(1);
    // The callee server never authors the terminal bubble.
    expect(m.history.finish).not.toHaveBeenCalled();
  });

  it('incoming on a busy local user returns CALL_BUSY as a business result + burns no quota', async () => {
    const { svc, m } = mkService();
    await svc.initiate(2, {
      callSid: 'local1',
      threadId: 11,
      callType: 'AUDIO',
    }); // occupy user 2
    m.quota.tick.mockClear();
    await expect(
      inbound(svc, { localUserId: 2, frame: mkFrame() }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        (e as { bizCode?: number }).bizCode === BusinessCode.CALL_BUSY,
    );
    expect(m.quota.tick).not.toHaveBeenCalled();
  });

  it('a duplicate incoming ring is an idempotent no-op (no second ring, no quota burn)', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    expect(callTombstoneCache.get(3, 'cs1', 'bbb.local')).toMatchObject({
      terminalOp: 'admitted',
      expiresAt: Date.now() + 300_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    m.sse.onCallEvent.mockClear();
    m.quota.tick.mockClear();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
    expect(m.quota.tick).not.toHaveBeenCalled();
  });

  it('preflights an incoming account collision before identity resolution', async () => {
    const { svc } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });

    expect(
      svc.onInboundIncomingPreflight({
        peerDomain: 'bbb.local',
        namespaceId: 3,
        // mkFrame returns the full frame union; the preflight contract is the incoming variant.
        frame: mkFrame() as Extract<S2SCallFrame, { op: 'incoming' }>,
      }),
    ).toBe(true);
    expect(() =>
      svc.onInboundIncomingPreflight({
        peerDomain: 'bbb.local',
        namespaceId: 3,
        frame: mkFrame({
          payload: { fromAccount: 'mallory', toAccount: 'bob' },
        }) as Extract<S2SCallFrame, { op: 'incoming' }>,
      }),
    ).toThrowError(
      expect.objectContaining({
        bizCode: BusinessCode.FEDERATION_MALFORMED,
      }),
    );
  });

  it('rejects a callSid collision instead of attaching it to the active call', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    m.quota.tick.mockClear();

    await expect(
      inbound(svc, {
        localUserId: 3,
        frame: mkFrame({
          payload: { fromAccount: 'bob', toAccount: 'charlie' },
        }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        (e as { bizCode?: number }).bizCode ===
        BusinessCode.FEDERATION_MALFORMED,
    );
    expect(m.quota.tick).not.toHaveBeenCalled();
  });

  it('treats a later frame from another signer as an unknown call without touching the active call', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    m.sse.onCallSignal.mockClear();

    await expect(
      inbound(svc, {
        localUserId: 3,
        peerDomain: 'other.local',
        frame: mkFrame({
          op: 'signal',
          payload: { signalType: 'ice', data: '{}' },
        }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        (e as { bizCode?: number }).bizCode === BusinessCode.CALL_NOT_ALLOWED,
    );
    expect(m.sse.onCallSignal).not.toHaveBeenCalled();
  });

  it('rejects an op sent in the opposite server direction', async () => {
    const { svc } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });

    await expect(
      inbound(svc, {
        localUserId: 2,
        frame: mkFrame({ op: 'accepted' }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        (e as { bizCode?: number }).bizCode ===
        BusinessCode.FEDERATION_MALFORMED,
    );
  });

  it('rejects connected and video-upgraded before their prerequisite state', async () => {
    const { svc } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });

    await expect(
      inbound(svc, {
        localUserId: 2,
        frame: mkFrame({
          op: 'connected',
        }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.FEDERATION_MALFORMED,
    );
    await expect(
      inbound(svc, {
        localUserId: 2,
        frame: mkFrame({ op: 'video-upgraded', callType: 'VIDEO' }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.FEDERATION_MALFORMED,
    );
  });

  it('accepted + connected transition the caller-side call and author the completed bubble', async () => {
    // Seed a caller-side live call via a federated initiate, then drive the inbound
    // accepted + connected + ended frames the peer sends back — the caller server authors the `completed`
    // bubble, stamping the local processing time of `connected` (not `accepted`).
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    m.sse.onCallEvent.mockClear();
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'accepted' }),
    });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'accepted' }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'connected' }),
    });
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'ended', payload: { endReason: 'completed' } }),
    });
    expect(lastBubbleContent(m)?.outcome).toBe('completed');
    expect(lastBubbleContent(m)?.connectedAt).toBe(
      lastBubbleContent(m)!.initiatedAt + 1000,
    ); // first local processing time, not peer time
  });

  it('absorbs a connected replay and preserves the first accepted startedAt', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'accepted' }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'connected' }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'connected' }),
    });

    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'ended', payload: { endReason: 'completed' } }),
    });
    expect(lastBubbleContent(m)?.connectedAt).toBe(
      lastBubbleContent(m)!.initiatedAt + 1000,
    );
  });

  it('applies a federated video upgrade on the callee server and notifies its local participant', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1');
    m.sse.onCallEvent.mockClear();

    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({ op: 'video-upgraded', callType: 'VIDEO' }),
    });

    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        type: 'video-upgraded',
        callSid: 'cs1',
        callType: 'VIDEO',
      }),
    );
  });

  it('an inbound `ringing` frame notifies the caller (idempotent on replay)', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    }); // caller-side live call
    m.sse.onCallEvent.mockClear();
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'ringing' }),
    });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'ringing' }),
    );
    // A replayed frame is an idempotent no-op (no second emit).
    m.sse.onCallEvent.mockClear();
    await inbound(svc, {
      localUserId: 1,
      frame: mkFrame({ op: 'ringing' }),
    });
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
  });

  it('signal relays a foreign frame without inventing a local sender ID', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({
        op: 'signal',
        payload: { signalType: 'ice', data: '{"cand":1}' },
      }),
    });
    expect(m.sse.onCallSignal).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        fromUserId: null,
        kind: 'ice',
        payload: '{"cand":1}',
      }),
    );
  });

  it('inbound signal stages on the callee server for the local callee to GET', async () => {
    const { svc } = mkService();
    // Only the callee has an Account ID on this server.
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({
        op: 'signal',
        payload: {
          signalId: 'offer-1',
          signalType: 'offer',
          data: 'OFFER_SDP',
        },
      }),
    });
    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({
        op: 'signal',
        payload: { signalId: 'ice-1', signalType: 'ice', data: 'ICE_1' },
      }),
    });
    // The local callee fetches the staged offer and caller ICE.
    expect(svc.signaling(2, 'cs1')).toEqual({
      offer: { id: 'offer-1', payload: 'OFFER_SDP' },
      ice: [{ id: 'ice-1', payload: 'ICE_1' }],
    });
  });

  it('uses the first signal body for an id and treats later bodies with that id as successful no-ops', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    m.sse.onCallSignal.mockClear();
    m.quota.tick.mockClear();

    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({
        op: 'signal',
        payload: {
          signalId: 'same-id',
          signalType: 'offer',
          data: 'FIRST',
        },
      }),
    });
    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({
        op: 'signal',
        payload: {
          signalId: 'same-id',
          signalType: 'answer',
          data: 'DIFFERENT',
        },
      }),
    });

    expect(m.sse.onCallSignal).toHaveBeenCalledTimes(1);
    expect(m.quota.tick).toHaveBeenCalledTimes(1);
    expect(svc.signaling(2, 'cs1')).toEqual({
      offer: { id: 'same-id', payload: 'FIRST' },
      ice: [],
    });
  });

  it('allows caller cancellation to win after the callee accepted locally', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await svc.accept(2, 'cs1');
    m.sse.onCallEvent.mockClear();

    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({ op: 'cancelled' }),
    });

    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'cancelled', callSid: 'cs1' }),
    );
    expect(() => svc.signaling(2, 'cs1')).toThrow();
  });

  it('persists local history and releases busy slots when terminal protection fails', async () => {
    const { svc, m, callState } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    await svc.initiate(1, { callSid: 'cs1', threadId: 10, callType: 'AUDIO' });
    await expect(svc.cancel(1, 'cs1')).resolves.toBeUndefined();
    expect(lastBubbleContent(m)).toMatchObject({ outcome: 'cancelled' });
    expect(callState.get(1)).toBeNull();
    await expect(
      svc.initiate(1, { callSid: 'cs2', threadId: 10, callType: 'AUDIO' }),
    ).resolves.toMatchObject({ callSid: 'cs2' });
    svc.onModuleDestroy();
  });

  it('rejects accepted during the tombstone-write window after local cancellation starts', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PPeers.mockResolvedValue([
      {
        account: 'bob',
        domain: 'bbb.local',
        namespaceId: 3,
        name: 'Bob',
        avatar: '',
      },
    ]);
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });

    const cancelling = svc.cancel(1, 'cs1');

    await expect(
      inbound(svc, {
        localUserId: 1,
        frame: mkFrame({ op: 'accepted' }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_CANCELLED,
    );

    await cancelling;
  });

  it.each([60, 360])(
    'caps inbound terminal protection with signature offset %i seconds',
    async (offset) => {
      const now = 1_700_000_000_123;
      vi.setSystemTime(now);
      const { svc, m } = mkService();
      await inbound(svc, { localUserId: 2, frame: mkFrame() });
      const signatureExpiresAtSec = Math.floor(now / 1000) + offset;
      await inbound(svc, {
        localUserId: 2,
        signatureExpiresAtSec,
        frame: mkFrame({ op: 'cancelled' }),
      });
      expect(callTombstoneCache.get(3, 'cs1', 'bbb.local')).toMatchObject({
        terminalOp: 'cancelled',
        expiresAt: Math.min(signatureExpiresAtSec * 1000, now + 300_000),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await inbound(svc, {
        localUserId: 2,
        signatureExpiresAtSec: signatureExpiresAtSec + 10,
        frame: mkFrame({ op: 'cancelled' }),
      });
      expect(m.database.db.insert).not.toHaveBeenCalled();
    },
  );

  it.each([null, { terminalOp: 'admitted', signalIds: [] }])(
    'bounds early cancellation including a persisted admission (%j)',
    async (prior) => {
      const now = 1_700_000_000_123;
      vi.setSystemTime(now);
      const { svc } = mkService();
      if (prior) {
        callTombstoneCache.admit({
          namespaceId: 3,
          callSid: 'cs1',
          initialCallType: 'AUDIO',
          finalCallType: 'AUDIO',
          expiresAt: 1_700_000_300_000,
          peerDomain: 'bbb.local',
        });
      }
      const expiresAt = new Date(1_700_000_020_000);
      await inbound(svc, {
        localUserId: 2,
        signatureExpiresAtSec: expiresAt.getTime() / 1000,
        frame: mkFrame({ op: 'cancelled' }),
      });
      expect(callTombstoneCache.get(3, 'cs1', 'bbb.local')).toMatchObject({
        terminalOp: 'cancelled',
        expiresAt: expiresAt.getTime(),
      });
    },
  );

  it('freezes local terminal expiry before a delayed database write and sends that expiry', async () => {
    const now = 1_700_000_000_123;
    vi.setSystemTime(now);
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await svc.decline(2, 'cs1');
    const signatureExpiresAtSec = 1_700_000_300;
    expect(m.federation.sendCallFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'declined',
        signatureExpiresAtSec,
      }),
      'bbb.local',
    );
    expect(callTombstoneCache.get(3, 'cs1', 'bbb.local')).toMatchObject({
      expiresAt: signatureExpiresAtSec * 1000,
    });
  });

  it('maps late frames through cancelled and other terminal tombstones', async () => {
    const { svc } = mkService();
    callTombstoneCache.cancelEarly({
      namespaceId: 3,
      callSid: 'cs1',
      expiresAt: Date.now() + 300_000,
      peerDomain: 'bbb.local',
    });
    await expect(
      inbound(svc, {
        localUserId: 1,
        frame: mkFrame({ op: 'accepted' }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_CANCELLED,
    );

    callTombstoneCache.clear();
    callTombstoneCache.finish({
      namespaceId: 3,
      callSid: 'cs1',
      terminalOp: 'ended',
      endReason: 'failed',
      initialCallType: 'AUDIO',
      finalCallType: 'AUDIO',
      signalIds: [],
      expiresAt: Date.now() + 300_000,
      peerDomain: 'bbb.local',
    });
    await expect(
      inbound(svc, {
        localUserId: 1,
        frame: mkFrame({ op: 'accepted' }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_TERMINATED,
    );
  });

  it('an unknown terminal frame returns CALL_NOT_ALLOWED without a bubble', async () => {
    const { svc, m } = mkService();
    await expect(
      inbound(svc, {
        localUserId: 2,
        frame: mkFrame({ op: 'missed' }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        (e as { bizCode?: number }).bizCode === BusinessCode.CALL_NOT_ALLOWED,
    );
    expect(m.history.finish).not.toHaveBeenCalled();
  });

  it('allows completed to end an accepted call before media connects', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await svc.accept(2, 'cs1');

    await expect(
      inbound(svc, {
        localUserId: 2,
        frame: mkFrame({
          op: 'ended',
          payload: { endReason: 'completed' },
        }),
      }),
    ).resolves.toBeUndefined();
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'ended', callSid: 'cs1' }),
    );
    expect(() => svc.signaling(2, 'cs1')).toThrow();
  });

  it('rejects a connection timeout after media connects', async () => {
    const { svc } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1');
    await expect(
      inbound(svc, {
        localUserId: 2,
        frame: mkFrame({ op: 'ended', payload: { endReason: 'timeout' } }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.FEDERATION_MALFORMED,
    );
  });

  it('the callee server writes its own terminal system notice', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, frame: mkFrame() });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1');
    await inbound(svc, {
      localUserId: 2,
      frame: mkFrame({ op: 'ended', payload: { endReason: 'completed' } }),
    });
    // The callee server released the call and emitted `ended`, but wrote no bubble.
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'ended' }),
    );
    expect(m.history.finish).toHaveBeenCalledOnce();
  });
});

describe('CallsService signaling store-and-forward', () => {
  it('applies the shared offer/answer/video-state direction and phase policy to local calls', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });

    await expect(
      svc.signal(2, {
        id: 'bad-offer',
        callSid: 'cs1',
        kind: 'offer',
        payload: 'SDP',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_INVALID_TRANSITION,
    );
    await expect(
      svc.signal(2, {
        id: 'early-answer',
        callSid: 'cs1',
        kind: 'answer',
        payload: 'SDP',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_INVALID_TRANSITION,
    );
    await expect(
      svc.signal(1, {
        id: 'early-video-state',
        callSid: 'cs1',
        kind: 'video-state',
        payload: '{"enabled":true}',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_INVALID_TRANSITION,
    );

    await svc.accept(2, 'cs1');
    await expect(
      svc.signal(2, {
        id: 'answer-1',
        callSid: 'cs1',
        kind: 'answer',
        payload: 'SDP',
      }),
    ).resolves.toBeUndefined();
  });

  it('stages the offer + caller ICE for the callee to GET (an offline callee still gets them on accept)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.signal(1, {
      id: 'offer-1',
      callSid: 'cs1',
      kind: 'offer',
      payload: 'OFFER_SDP',
    });
    await svc.signal(1, {
      id: 'ice-1',
      callSid: 'cs1',
      kind: 'ice',
      payload: 'ICE_1',
    });
    await svc.signal(1, {
      id: 'ice-2',
      callSid: 'cs1',
      kind: 'ice',
      payload: 'ICE_2',
    });
    // The callee fetches → the offer + the caller's ICE.
    expect(svc.signaling(2, 'cs1')).toEqual({
      offer: { id: 'offer-1', payload: 'OFFER_SDP' },
      ice: [
        { id: 'ice-1', payload: 'ICE_1' },
        { id: 'ice-2', payload: 'ICE_2' },
      ],
    });
  });

  it('stages the answer + callee ICE for the caller to GET', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await svc.signal(2, {
      id: 'answer-1',
      callSid: 'cs1',
      kind: 'answer',
      payload: 'ANSWER_SDP',
    });
    await svc.signal(2, {
      id: 'ice-1',
      callSid: 'cs1',
      kind: 'ice',
      payload: 'CALLEE_ICE',
    });
    expect(svc.signaling(1, 'cs1')).toEqual({
      answer: { id: 'answer-1', payload: 'ANSWER_SDP' },
      ice: [{ id: 'ice-1', payload: 'CALLEE_ICE' }],
    });
  });

  it('dedupes a replayed ICE candidate (no duplicate in the staged list)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.signal(1, {
      id: 'ice-retry',
      callSid: 'cs1',
      kind: 'ice',
      payload: 'ICE_X',
    });
    await svc.signal(1, {
      id: 'ice-retry',
      callSid: 'cs1',
      kind: 'ice',
      payload: 'ICE_X',
    }); // retransmit
    expect(svc.signaling(2, 'cs1').ice).toEqual([
      { id: 'ice-retry', payload: 'ICE_X' },
    ]);
  });

  it('clears the staged signaling on connect (media up → setup consumed)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.signal(1, {
      id: 'offer-1',
      callSid: 'cs1',
      kind: 'offer',
      payload: 'OFFER_SDP',
    });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1'); // callee confirms media up
    expect(svc.signaling(2, 'cs1')).toEqual({ offer: null, ice: [] });
  });

  it('rejects a GET from a non-participant', async () => {
    const { svc } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    let threw: unknown = null;
    try {
      svc.signaling(99, 'cs1'); // sync — throws rather than rejecting
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(bizCode(threw)).toBe(BusinessCode.CALL_NOT_PARTICIPANT);
  });

  it('rejects a GET for an unknown call', () => {
    const { svc } = mkService();
    let threw: unknown = null;
    try {
      svc.signaling(2, 'nope');
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(bizCode(threw)).toBe(BusinessCode.CALL_NOT_FOUND);
  });
});

describe('CallsService active-call registry (HELLO activeCall)', () => {
  it('initiate mirrors the call into the registry for both participants; a terminal clears it', async () => {
    const { svc, callState } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    expect(callState.get(1)).toMatchObject({
      callSid: 'cs1',
      peerUserId: 2,
      isCaller: true,
      state: 'ringing',
      startedAt: null,
    });
    expect(callState.get(2)).toMatchObject({
      callSid: 'cs1',
      peerUserId: 1,
      isCaller: false,
      state: 'ringing',
    });
    // After the call ends, both are cleared — a reconnecting client's HELLO sees no active call.
    await svc.decline(2, 'cs1');
    expect(callState.get(1)).toBeNull();
    expect(callState.get(2)).toBeNull();
  });

  it('connected updates the mirrored state to connected + stamps startedAt', async () => {
    const { svc, callState } = mkService();
    await svc.initiate(1, {
      callSid: 'cs1',
      threadId: 10,
      callType: 'AUDIO',
    });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1');
    expect(callState.get(1)).toMatchObject({ state: 'connected' });
    expect(callState.get(1)?.startedAt).toBeTypeOf('number');
  });
});

describe('CallsService — unused CallOutcome alias keeps the import live', () => {
  it('the terminal outcome union is exported', () => {
    const ok: CallOutcome[] = [
      'completed',
      'cancelled',
      'declined',
      'missed',
      'failed',
      'unreachable',
    ];
    expect(ok).toHaveLength(6);
  });
});
