// Unit tests for CallsService — the in-memory live state machine, bilateral lifecycle fan-out,
// terminal CALL-bubble persistence, signaling relay, and the ringing-timeout backstop. The deps
// (prisma, SSE, push, participants, MessageService, MessageFanoutService) are mocked; the service is
// instantiated directly (the codebase's unit-spec convention).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallsService } from './calls.service.js';
import { BusinessCode } from '../common/business-code.js';
import { ContentType } from '../prisma/generated/client.js';
import { parseCallContent } from './call-content.js';
import type { CallOutcome } from './call-content.js';
import type { S2SCallFrame, S2SAddress } from '../federation/federation.service.js';

/** Build a minimal Message-like object writeMsgToThread resolves with (Omit<Message,'id'>). */
function mkMsg(p: Partial<{ seq: number; threadId: number; creator: number; contentType: ContentType }> = {}) {
  return {
    seq: p.seq ?? 1,
    threadId: p.threadId ?? 10,
    creator: p.creator ?? 1,
    contentType: p.contentType ?? ContentType.CALL,
    content: '{}',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDeleted: false,
    clientMessageId: null,
    originSeq: 1,
  };
}

function mkMocks() {
  return {
    prisma: {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          isForeigner: false,
          account: 'alice',
          domain: 'local',
          name: 'Alice',
          avatar: 'a.webp',
        }),
      },
    },
    sse: { onCallEvent: vi.fn(), onCallSignal: vi.fn() },
    push: { dispatchForCall: vi.fn().mockResolvedValue(undefined) },
    participants: { findP2PThreadBetween: vi.fn().mockResolvedValue(10) },
    messages: { writeMsgToThread: vi.fn().mockResolvedValue(mkMsg()) },
    fanout: { dispatch: vi.fn().mockResolvedValue(undefined) },
    federation: { sendCallFrame: vi.fn().mockResolvedValue(undefined) },
    quota: { tick: vi.fn().mockResolvedValue(undefined), peek: vi.fn().mockResolvedValue(undefined) },
  };
}

function mkService(m = mkMocks()) {
  return {
    svc: new CallsService(
      m.prisma as never,
      m.sse as never,
      m.push as never,
      m.participants as never,
      m.messages as never,
      m.fanout as never,
      m.federation as never,
      m.quota as never,
    ),
    m,
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

/** The parsed CALL content of the LAST terminal bubble write (null if none / unparseable). */
function lastBubbleContent(m: ReturnType<typeof mkMocks>) {
  const call = m.messages.writeMsgToThread.mock.calls.at(-1);
  if (!call) return null;
  // writeMsgToThread(userId, threadId, content, type, clientMessageId)
  return parseCallContent(call[2] as string);
}

describe('CallsService.initiate', () => {
  it('registers a live ringing call, rings the callee in-band (SSE) + to all devices (push)', async () => {
    const { svc, m } = mkService();
    const res = await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    expect(res).toEqual({ callSid: 'cs1', threadId: 10 });
    // Ring: SSE to callee (with caller display info) + push to the callee's devices.
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'incoming', callerUserId: 1, callerName: 'Alice', callType: 'AUDIO' }),
    );
    expect(m.push.dispatchForCall).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ callSid: 'cs1', callerUserId: 1, callType: 'AUDIO' }),
    );
    // No terminal bubble yet — the call is live.
    expect(m.messages.writeMsgToThread).not.toHaveBeenCalled();
  });

  it('refuses calling yourself', async () => {
    const { svc } = mkService();
    await expect(svc.initiate(1, { callSid: 'cs1', calleeUserId: 1, callType: 'AUDIO' })).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_ALLOWED,
    );
  });

  it('refuses a non-friend callee (no P2P thread)', async () => {
    const { svc, m } = mkService();
    m.participants.findP2PThreadBetween.mockResolvedValue(null);
    await expect(svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' })).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_ALLOWED,
    );
  });

  it('rejects when the caller is already in an active call (busy)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' }); // caller 1 now busy
    await expect(svc.initiate(1, { callSid: 'cs2', calleeUserId: 3, callType: 'AUDIO' })).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY,
    );
  });

  it('rejects when the callee is already in an active call (busy)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' }); // callee 2 now busy
    await expect(svc.initiate(3, { callSid: 'cs2', calleeUserId: 2, callType: 'AUDIO' })).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY,
    );
  });

  it('is idempotent on callSid — a retry re-rings the still-ringing call, no new live call', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    m.sse.onCallEvent.mockClear();
    const res = await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    expect(res).toEqual({ callSid: 'cs1', threadId: 10 });
    expect(m.sse.onCallEvent).toHaveBeenCalled(); // re-rang
    // The caller is still in exactly one call: a brand-new callSid still trips busy on the caller.
    await expect(svc.initiate(1, { callSid: 'csX', calleeUserId: 3, callType: 'AUDIO' })).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY,
    );
  });
});

describe('CallsService bilateral lifecycle fan-out', () => {
  it('accept fans `accepted` to BOTH caller and callee (callee-other-devices dismiss ringing)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
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
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    m.sse.onCallEvent.mockClear();
    await svc.ringing(2, 'cs1');
    expect(
      new Set(m.sse.onCallEvent.mock.calls.map((c) => (c[1] as { type: string }).type)).has('ringing'),
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
      new Set(m.sse.onCallEvent.mock.calls.map((c) => (c[1] as { type: string }).type)).has('accepted'),
    ).toBe(true);
  });

  it('decline / cancel / ended each fan to BOTH participants; incoming is callee-only; missed is caller-only', async () => {
    // incoming (from initiate) → callee only
    const a = mkService();
    await a.svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
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
    await b.svc.initiate(1, { callSid: 'cs2', calleeUserId: 3, callType: 'AUDIO' });
    b.m.sse.onCallEvent.mockClear();
    await b.svc.cancel(1, 'cs2');
    expect(eventRecipients(b.m).sort()).toEqual([1, 3]);

    // decline → both
    const c = mkService();
    await c.svc.initiate(4, { callSid: 'cs3', calleeUserId: 5, callType: 'VIDEO' });
    c.m.sse.onCallEvent.mockClear();
    await c.svc.decline(5, 'cs3');
    expect(eventRecipients(c.m).sort()).toEqual([4, 5]);
  });
});

describe('CallsService terminal bubble persistence', () => {
  it('decline writes a `declined` CALL bubble authored by the caller, clientMessageId = callSid', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.decline(2, 'cs1');
    expect(m.messages.writeMsgToThread).toHaveBeenCalledWith(
      1, // creator = callerId
      10,
      expect.any(String),
      ContentType.CALL,
      'cs1', // clientMessageId = callSid (idempotent terminal write)
    );
    expect(lastBubbleContent(m)).toMatchObject({
      type: 'CALL',
      callType: 'AUDIO',
      status: 'declined',
      callerId: 1,
      calleeId: 2,
    });
    // An unanswered call never connected → no startedAt/duration.
    const c = lastBubbleContent(m)!;
    expect(c.startedAt).toBeUndefined();
    expect(c.durationMs).toBeUndefined();
    void m.fanout.dispatch; // dispatched (fire-and-forget) — exercised below
    expect(m.fanout.dispatch).toHaveBeenCalledOnce();
  });

  it('cancel writes a `cancelled` bubble', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.cancel(1, 'cs1');
    expect(lastBubbleContent(m)?.status).toBe('cancelled');
  });

  it('connected (media up) stamps startedAt; end → completed bubble WITH duration', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'VIDEO' });
    await svc.accept(2, 'cs1'); // answered — NOT connected yet (no startedAt)
    await svc.connected(1, 'cs1'); // media up → startedAt stamped
    await svc.end(1, 'cs1', 'completed');
    const c = lastBubbleContent(m)!;
    expect(c).toMatchObject({ status: 'completed', callType: 'VIDEO', callerId: 1, calleeId: 2 });
    expect(c.startedAt).toBeTypeOf('number');
    expect(c.durationMs).toBeTypeOf('number');
    expect(c.endedAt).toBeTypeOf('number');
  });

  it('accept alone does NOT set startedAt — answered-but-never-connected end → failed (no duration)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1'); // answered, media never came up
    await svc.end(2, 'cs1');
    const c = lastBubbleContent(m)!;
    expect(c.status).toBe('failed'); // a connection failure
    expect(c.startedAt).toBeUndefined(); // never really connected
    expect(c.durationMs).toBeUndefined();
  });

  it('end with reason `failed` after connected → failed WITH duration (connected-then-failed)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1');
    await svc.connected(2, 'cs1'); // connected
    await svc.end(2, 'cs1', 'failed');
    const c = lastBubbleContent(m)!;
    expect(c.status).toBe('failed');
    expect(c.startedAt).toBeTypeOf('number'); // it HAD connected
  });

  it('a terminal transition releases both busy slots (the users can place a new call)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.cancel(1, 'cs1');
    // Both 1 and 2 are free again — a fresh call between them succeeds.
    await expect(svc.initiate(2, { callSid: 'cs2', calleeUserId: 1, callType: 'AUDIO' })).resolves.toEqual({
      callSid: 'cs2',
      threadId: 10,
    });
  });
});

describe('CallsService.accept / decline / cancel / end guards', () => {
  it('accept by a non-callee is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(svc.accept(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('accept on a non-ringing call is not found', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1'); // → accepted
    await expect(svc.accept(2, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_FOUND,
    );
  });

  it('ringing by a non-callee is rejected; ringing on a non-ringing call is not found', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(svc.ringing(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
    await svc.accept(2, 'cs1'); // → accepted (no longer ringing)
    await expect(svc.ringing(2, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_FOUND,
    );
  });

  it('decline by a non-callee is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(svc.decline(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('cancel by a non-caller is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(svc.cancel(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('end on a ringing (not-yet-connected) call is not found', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(svc.end(1, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_FOUND,
    );
  });

  it('end by a non-participant is rejected', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1');
    await expect(svc.end(99, 'cs1')).rejects.toSatisfy(
      (e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT,
    );
  });

  it('decline / cancel are idempotent on an already-terminal call (no second bubble)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.decline(2, 'cs1');
    await svc.decline(2, 'cs1'); // already terminal → no-op
    expect(m.messages.writeMsgToThread).toHaveBeenCalledTimes(1);
  });
});

describe('CallsService.signal (relay)', () => {
  it('relays a frame from a participant to the other participant over SSE', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1');
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'ice', payload: '{"cand":1}' });
    expect(m.sse.onCallSignal).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ callSid: 'cs1', fromUserId: 1, kind: 'ice', payload: '{"cand":1}' }),
    );
  });

  it('rejects a sender who is not a participant', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(
      svc.signal(99, { callSid: 'cs1', toUserId: 2, kind: 'ice', payload: '{}' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT);
  });

  it('rejects relaying to anyone but the call peer', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await expect(
      svc.signal(1, { callSid: 'cs1', toUserId: 77, kind: 'ice', payload: '{}' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_PARTICIPANT);
  });

  it('rejects relaying on an unknown / no-longer-live callSid', async () => {
    const { svc } = mkService();
    await expect(
      svc.signal(1, { callSid: 'nope', toUserId: 2, kind: 'ice', payload: '{}' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_NOT_FOUND);
  });
});

describe('CallsService ringing timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips ringing → missed after the timeout, fans `missed` to the CALLER only, writes the bubble', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    m.sse.onCallEvent.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    // missed → caller only (the callee learns of the missed call from the bubble).
    expect(eventRecipients(m)).toEqual([1]);
    expect(m.sse.onCallEvent.mock.calls[0][1]).toMatchObject({ type: 'missed' });
    expect(lastBubbleContent(m)?.status).toBe('missed');
    // Slots released → caller can place a new call.
    await expect(svc.initiate(1, { callSid: 'cs2', calleeUserId: 2, callType: 'AUDIO' })).resolves.toBeDefined();
  });

  it('does NOT time out after the media leg connected (the timer is disarmed on connected, not accept)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1'); // answered — the timer is STILL armed (media not yet up)
    await svc.connected(2, 'cs1'); // media up → timer disarmed
    m.messages.writeMsgToThread.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    // Connected → no timeout terminal write fired.
    expect(m.messages.writeMsgToThread).not.toHaveBeenCalled();
  });

  it('an answered-but-never-connected call times out → failed (a connection failure, NOT missed)', async () => {
    const { svc, m } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.accept(2, 'cs1'); // answered, media never comes up
    m.messages.writeMsgToThread.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    // `accepted` at timeout → `failed` (the callee DID answer, so it is not `missed`).
    expect(lastBubbleContent(m)?.status).toBe('failed');
  });
});

/** Build an inbound S2SCallFrame (the wire shape FederationService resolves + emits on
 *  'call.frame.inbound'). Defaults describe S_B's server ringing OUR local user (alice@aaa.local). */
function mkFrame(p: Partial<S2SCallFrame> = {}): S2SCallFrame {
  return {
    id: 'fid1',
    origin: 'bbb.local',
    ts: 0,
    from: { account: 'bob', domain: 'bbb.local' },
    to: { account: 'alice', domain: 'aaa.local' },
    callSid: 'cs1',
    op: 'incoming',
    callType: 'AUDIO',
    ...p,
  } as S2SCallFrame;
}

/** Drive the inbound bridge (the @OnEvent handler) directly. */
function inbound(
  svc: CallsService,
  args: { localUserId: number; peerStubId: number; threadId?: number; frame: S2SCallFrame },
): Promise<void> {
  return svc.onInboundCallFrame({
    localUserId: args.localUserId,
    peerStubId: args.peerStubId,
    threadId: args.threadId ?? 10,
    frame: args.frame,
  });
}

describe('CallsService federated initiate (outbound)', () => {
  it('a foreigner callee is rung via an S2S incoming frame (no local ring); both busy slots set', async () => {
    const { svc, m } = mkService();
    m.prisma.user.findUnique.mockResolvedValue({
      isForeigner: true, account: 'bob', domain: 'bbb.local', name: 'Bob', avatar: '',
    });
    const res = await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'VIDEO' });
    expect(res).toEqual({ callSid: 'cs1', threadId: 10 });
    expect(m.federation.sendCallFrame).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'incoming', fromLocalUserId: 1, callType: 'VIDEO' }),
      'bbb.local',
    );
    expect(
      (m.federation.sendCallFrame.mock.calls[0][0] as { to: S2SAddress }).to,
    ).toEqual({ account: 'bob', domain: 'bbb.local' });
    // No local ring — the foreign callee is rung on its own server.
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
    expect(m.push.dispatchForCall).not.toHaveBeenCalled();
    // Both busy slots set (caller + the foreign stub) → a second call trips busy.
    await expect(
      svc.initiate(1, { callSid: 'cs2', calleeUserId: 3, callType: 'AUDIO' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_BUSY);
  });

  it('a ring failure writes an `unreachable` bubble + throws CALL_PEER_UNREACHABLE + releases slots', async () => {
    const { svc, m } = mkService();
    m.prisma.user.findUnique.mockResolvedValue({
      isForeigner: true, account: 'bob', domain: 'bbb.local', name: 'Bob', avatar: '',
    });
    m.federation.sendCallFrame.mockRejectedValue(new Error('network down'));
    await expect(
      svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' }),
    ).rejects.toSatisfy((e: unknown) => bizCode(e) === BusinessCode.CALL_PEER_UNREACHABLE);
    expect(lastBubbleContent(m)?.status).toBe('unreachable');
    // Slots released → a fresh call can start.
    m.federation.sendCallFrame.mockResolvedValue(undefined);
    await expect(
      svc.initiate(1, { callSid: 'csX', calleeUserId: 2, callType: 'AUDIO' }),
    ).resolves.toBeDefined();
  });
});

describe('CallsService federated inbound (@OnEvent call.frame.inbound)', () => {
  it('incoming registers a mirror (origin false), rings the local user, ticks quota once', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'incoming', callerUserId: 5 }),
    );
    expect(m.push.dispatchForCall).toHaveBeenCalledWith(2, expect.objectContaining({ callSid: 'cs1' }));
    expect(m.quota.tick).toHaveBeenCalledWith('bbb.local', 'requests');
    expect(m.quota.tick).toHaveBeenCalledTimes(1);
    // origin=false → no terminal bubble is ever authored on this (callee) side.
    expect(m.messages.writeMsgToThread).not.toHaveBeenCalled();
  });

  it('incoming on a busy local user throws CALL_BUSY @422 (non-demoting) + burns no quota', async () => {
    const { svc, m } = mkService();
    await svc.initiate(2, { callSid: 'local1', calleeUserId: 3, callType: 'AUDIO' }); // occupy user 2
    m.quota.tick.mockClear();
    await expect(
      inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() }),
    ).rejects.toSatisfy((e: unknown) => (e as { bizCode?: number }).bizCode === BusinessCode.CALL_BUSY);
    expect(m.quota.tick).not.toHaveBeenCalled();
  });

  it('a duplicate incoming ring is an idempotent no-op (no second ring, no quota burn)', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() });
    m.sse.onCallEvent.mockClear();
    m.quota.tick.mockClear();
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() });
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
    expect(m.quota.tick).not.toHaveBeenCalled();
  });

  it('accepted + connected transition the mirror; the ORIGIN authors the completed bubble', async () => {
    // Seed an ORIGIN live call (caller's server) via a federated initiate, then drive the inbound
    // accepted + connected + ended frames the peer sends back — the origin must author the `completed`
    // bubble, stamping startedAt from the `connected` frame (NOT `accepted`).
    const { svc, m } = mkService();
    m.prisma.user.findUnique.mockResolvedValue({
      isForeigner: true, account: 'bob', domain: 'bbb.local', name: 'Bob', avatar: '',
    });
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    m.sse.onCallEvent.mockClear();
    await inbound(svc, {
      localUserId: 1, peerStubId: 2,
      frame: mkFrame({ op: 'accepted' }),
    });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'accepted' }));
    await inbound(svc, {
      localUserId: 1, peerStubId: 2,
      frame: mkFrame({ op: 'connected', startedAt: 1000 }),
    });
    await inbound(svc, {
      localUserId: 1, peerStubId: 2,
      frame: mkFrame({ op: 'ended', endReason: 'completed' }),
    });
    expect(lastBubbleContent(m)?.status).toBe('completed');
    expect(lastBubbleContent(m)?.startedAt).toBe(1000); // from the `connected` frame, not `accepted`
  });

  it('an inbound `ringing` frame emits `ringing` to the origin caller (idempotent on replay)', async () => {
    const { svc, m } = mkService();
    m.prisma.user.findUnique.mockResolvedValue({
      isForeigner: true, account: 'bob', domain: 'bbb.local', name: 'Bob', avatar: '',
    });
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' }); // origin live call
    m.sse.onCallEvent.mockClear();
    await inbound(svc, { localUserId: 1, peerStubId: 2, frame: mkFrame({ op: 'ringing' }) });
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'ringing' }));
    // A replayed frame is an idempotent no-op (no second emit).
    m.sse.onCallEvent.mockClear();
    await inbound(svc, { localUserId: 1, peerStubId: 2, frame: mkFrame({ op: 'ringing' }) });
    expect(m.sse.onCallEvent).not.toHaveBeenCalled();
  });

  it('signal relays a WebRTC frame to the local user with fromUserId = the peer stub', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() });
    await inbound(svc, {
      localUserId: 2, peerStubId: 5,
      frame: mkFrame({ op: 'signal', kind: 'ice', payload: '{"cand":1}' }),
    });
    expect(m.sse.onCallSignal).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ fromUserId: 5, kind: 'ice', payload: '{"cand":1}' }),
    );
  });

  it('inbound signal STAGES on the mirror for the local callee to GET (federated store-and-forward)', async () => {
    const { svc } = mkService();
    // mirror: localUserId=2 is the callee; peerStubId=5 is the foreign caller's stub (= callerId on the mirror).
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() });
    await inbound(svc, {
      localUserId: 2, peerStubId: 5,
      frame: mkFrame({ op: 'signal', kind: 'offer', payload: 'OFFER_SDP' }),
    });
    await inbound(svc, {
      localUserId: 2, peerStubId: 5,
      frame: mkFrame({ op: 'signal', kind: 'ice', payload: 'ICE_1' }),
    });
    // The local callee (2) fetches → the staged offer + the caller's ICE (the mirror held them).
    expect(svc.signaling(2, 'cs1')).toEqual({ offer: 'OFFER_SDP', ice: ['ICE_1'] });
  });

  it('a terminal frame with no mirror is an idempotent no-op (no double bubble)', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame({ op: 'missed' }) });
    expect(m.messages.writeMsgToThread).not.toHaveBeenCalled();
  });

  it('a non-origin terminal does NOT author a bubble (the callee side pulls the origin\'s)', async () => {
    const { svc, m } = mkService();
    await inbound(svc, { localUserId: 2, peerStubId: 5, frame: mkFrame() }); // mirror (origin false)
    await inbound(svc, {
      localUserId: 2, peerStubId: 5,
      frame: mkFrame({ op: 'ended', endReason: 'completed' }),
    });
    // The mirror released + emitted `ended` to the local user, but NO bubble (origin=false).
    expect(m.sse.onCallEvent).toHaveBeenCalledWith(2, expect.objectContaining({ type: 'ended' }));
    expect(m.messages.writeMsgToThread).not.toHaveBeenCalled();
  });
});

describe('CallsService signaling store-and-forward', () => {
  it('stages the offer + caller ICE for the callee to GET (an offline callee still gets them on accept)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'offer', payload: 'OFFER_SDP' });
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'ice', payload: 'ICE_1' });
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'ice', payload: 'ICE_2' });
    // The callee fetches → the offer + the caller's ICE.
    expect(svc.signaling(2, 'cs1')).toEqual({ offer: 'OFFER_SDP', ice: ['ICE_1', 'ICE_2'] });
  });

  it('stages the answer + callee ICE for the caller to GET', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.signal(2, { callSid: 'cs1', toUserId: 1, kind: 'answer', payload: 'ANSWER_SDP' });
    await svc.signal(2, { callSid: 'cs1', toUserId: 1, kind: 'ice', payload: 'CALLEE_ICE' });
    expect(svc.signaling(1, 'cs1')).toEqual({ answer: 'ANSWER_SDP', ice: ['CALLEE_ICE'] });
  });

  it('dedupes a replayed ICE candidate (no duplicate in the staged list)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'ice', payload: 'ICE_X' });
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'ice', payload: 'ICE_X' }); // retransmit
    expect(svc.signaling(2, 'cs1').ice).toEqual(['ICE_X']);
  });

  it('clears the staged signaling on connect (media up → setup consumed)', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
    await svc.signal(1, { callSid: 'cs1', toUserId: 2, kind: 'offer', payload: 'OFFER_SDP' });
    await svc.accept(2, 'cs1');
    await svc.connected(1, 'cs1'); // media up
    expect(svc.signaling(2, 'cs1')).toEqual({ offer: null, ice: [] });
  });

  it('rejects a GET from a non-participant', async () => {
    const { svc } = mkService();
    await svc.initiate(1, { callSid: 'cs1', calleeUserId: 2, callType: 'AUDIO' });
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

describe('CallsService — unused CallOutcome alias keeps the import live', () => {
  it('the terminal status union is exported', () => {
    const ok: CallOutcome[] = ['completed', 'cancelled', 'declined', 'missed', 'failed', 'unreachable'];
    expect(ok).toHaveLength(6);
  });
});
