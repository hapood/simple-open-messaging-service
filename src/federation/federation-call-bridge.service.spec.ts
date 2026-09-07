import { describe, expect, it, vi } from 'vitest';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { toS2SCallWireFrame } from '../calls/federated-call-protocol.js';

describe('federated call identities', () => {
  it('authorizes an incoming peer address without manufacturing a local account ID', async () => {
    const participants = {
      findP2PThreadBetween: vi.fn().mockResolvedValue(90),
    };
    const directory = { findLocalUserId: vi.fn().mockResolvedValue(2) };
    const events = { emitAsync: vi.fn().mockResolvedValue([]) };
    const bridge = new FederationCallBridgeService(
      {
        db: {
          query: {
            callTombstone: { findFirst: vi.fn().mockResolvedValue(null) },
          },
        },
      } as never,
      {} as never,
      directory as never,
      participants as never,
      { peek: vi.fn().mockResolvedValue(undefined) } as never,
      events as never,
    );
    const frame = {
      callSid: '00000000-0000-4000-8000-000000000001',
      op: 'incoming' as const,
      callType: 'AUDIO' as const,
      payload: { fromAccount: 'caller', toAccount: 'callee' },
    };
    await bridge.handleFrame(
      toS2SCallWireFrame(frame),
      'peer.test',
      7,
      2000000000,
    );
    expect(participants.findP2PThreadBetween).toHaveBeenCalledWith(2, {
      account: 'caller',
      domain: 'peer.test',
      namespaceId: 7,
    });
    expect(events.emitAsync).toHaveBeenLastCalledWith('call.frame.inbound', {
      localUserId: 2,
      threadId: 90,
      peerDomain: 'peer.test',
      namespaceId: 7,
      signatureExpiresAtSec: 2000000000,
      frame,
    });
  });
});
