import { describe, expect, it, vi } from 'vitest';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';

const callSid = '550e8400-e29b-41d4-a716-446655440000';

function makeSubject() {
  const database = {
    db: {
      query: {
        callTombstone: { findFirst: vi.fn().mockResolvedValue(null) },
      },
    },
  };
  const peerHttp = { post: vi.fn().mockResolvedValue(undefined) };
  const users = {
    requireLocalAccount: vi.fn().mockResolvedValue('alice'),
    ensureForeignUser: vi.fn().mockResolvedValue(41),
    findLocalUserId: vi.fn().mockResolvedValue(17),
  };
  const participants = {
    findP2PThreadBetween: vi.fn().mockResolvedValue(29),
  };
  const quota = { peek: vi.fn().mockResolvedValue(undefined) };
  const eventEmitter = { emitAsync: vi.fn().mockResolvedValue([]) };
  const subject = new FederationCallBridgeService(
    database as never,
    peerHttp as never,
    users as never,
    participants as never,
    quota as never,
    eventEmitter as never,
  );
  return {
    subject,
    database,
    peerHttp,
    users,
    participants,
    quota,
    eventEmitter,
  };
}

describe('FederationCallBridgeService', () => {
  it('short-circuits a handled incoming retry before admission or identity lookup', async () => {
    const { subject, database, eventEmitter, users, participants, quota } =
      makeSubject();
    eventEmitter.emitAsync.mockResolvedValueOnce([true]);

    await subject.handleFrame(
      {
        callId: callSid,
        operation: 'incoming',
        mediaType: 'AUDIO',
        payload: { callerAccount: 'alice', calleeAccount: 'bob' },
      },
      'peer.example',
      3,
      Math.floor(Date.now() / 1000) + 300,
    );

    expect(eventEmitter.emitAsync).toHaveBeenCalledExactlyOnceWith(
      'call.frame.incoming.preflight',
      {
        peerDomain: 'peer.example',
        namespaceId: 3,
        frame: {
          callSid,
          op: 'incoming',
          callType: 'AUDIO',
          payload: { fromAccount: 'alice', toAccount: 'bob' },
        },
      },
    );
    expect(database.db.query.callTombstone.findFirst).not.toHaveBeenCalled();
    expect(quota.peek).not.toHaveBeenCalled();
    expect(users.ensureForeignUser).not.toHaveBeenCalled();
    expect(users.findLocalUserId).not.toHaveBeenCalled();
    expect(participants.findP2PThreadBetween).not.toHaveBeenCalled();
  });

  it('translates and sends an outbound incoming frame', async () => {
    const { subject, peerHttp, users } = makeSubject();

    await subject.sendFrame(
      {
        fromLocalUserId: 17,
        to: { account: 'bob', domain: 'peer.example' },
        callSid,
        callType: 'AUDIO',
        op: 'incoming',
      },
      'peer.example',
    );

    expect(users.requireLocalAccount).toHaveBeenCalledWith(17);
    expect(peerHttp.post).toHaveBeenCalledWith(
      '/s2s/v1/call',
      JSON.stringify({
        callId: callSid,
        operation: 'incoming',
        mediaType: 'AUDIO',
        payload: { callerAccount: 'alice', calleeAccount: 'bob' },
      }),
      'peer.example',
    );
  });

  it('passes terminal signature expiry as transport metadata without changing the wire body', async () => {
    const { subject, peerHttp } = makeSubject();
    await subject.sendFrame(
      {
        fromLocalUserId: 17,
        to: { account: 'bob', domain: 'peer.example' },
        callSid,
        op: 'ended',
        endReason: 'completed',
        signatureExpiresAtSec: 1_700_000_300,
      },
      'peer.example',
    );
    expect(peerHttp.post).toHaveBeenCalledWith(
      '/s2s/v1/call',
      JSON.stringify({
        callId: callSid,
        operation: 'ended',
        payload: { endReason: 'completed' },
      }),
      'peer.example',
      { signatureExpiresAtSec: 1_700_000_300 },
    );
  });

  it('forwards a non-incoming frame without identity resolution', async () => {
    const { subject, eventEmitter, users } = makeSubject();

    await subject.handleFrame(
      { callId: callSid, operation: 'accepted' },
      'peer.example',
      3,
      1_700_000_000,
    );

    expect(eventEmitter.emitAsync).toHaveBeenCalledWith('call.frame.inbound', {
      peerDomain: 'peer.example',
      namespaceId: 3,
      signatureExpiresAtSec: 1_700_000_000,
      frame: { callSid, op: 'accepted' },
    });
    expect(users.ensureForeignUser).not.toHaveBeenCalled();
  });

  it('resolves an incoming caller and emits the local thread context', async () => {
    const { subject, eventEmitter, users, participants, quota } = makeSubject();

    await subject.handleFrame(
      {
        callId: callSid,
        operation: 'incoming',
        mediaType: 'VIDEO',
        payload: { callerAccount: 'alice', calleeAccount: 'bob' },
      },
      'peer.example',
      3,
      1_700_000_000,
    );

    expect(quota.peek).toHaveBeenCalledWith('peer.example', 'requests');
    expect(users.ensureForeignUser).toHaveBeenCalledWith(
      'alice',
      'peer.example',
      3,
    );
    expect(participants.findP2PThreadBetween).toHaveBeenCalledWith(17, 41);
    expect(eventEmitter.emitAsync).toHaveBeenLastCalledWith(
      'call.frame.inbound',
      {
        localUserId: 17,
        peerStubId: 41,
        peerDomain: 'peer.example',
        namespaceId: 3,
        signatureExpiresAtSec: 1_700_000_000,
        threadId: 29,
        frame: {
          callSid,
          op: 'incoming',
          callType: 'VIDEO',
          payload: { fromAccount: 'alice', toAccount: 'bob' },
        },
      },
    );
  });
});
