import { describe, expect, it, vi } from 'vitest';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { callTombstoneCache } from '../calls/call-tombstone-cache.js';
import { toS2SCallWireFrame } from '../calls/federated-call-protocol.js';

describe('federated call identities', () => {
  it('checks new-call readiness without gating existing frame delivery', async () => {
    const error = new Error('degraded');
    const lifecycle = { checkOutboundReady: vi.fn().mockRejectedValue(error) };
    const post = vi.fn().mockResolvedValue(undefined);
    const bridge = new FederationCallBridgeService(
      { post } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      lifecycle as never,
    );
    await expect(bridge.checkOutboundReady('peer.test')).rejects.toBe(error);
    expect(lifecycle.checkOutboundReady).toHaveBeenCalledWith('peer.test');
    expect(post).not.toHaveBeenCalled();
    await bridge.sendFrame(
      {
        callSid: '00000000-0000-4000-8000-000000000001',
        fromLocalUserId: 1,
        to: { account: 'callee', domain: 'peer.test' },
        op: 'cancelled',
      },
      'peer.test',
    );
    expect(post).toHaveBeenCalledOnce();
    expect(lifecycle.checkOutboundReady).toHaveBeenCalledOnce();
  });
  it('authorizes an incoming peer address without manufacturing a local account ID', async () => {
    const participants = {
      findP2PThreadBetween: vi.fn().mockResolvedValue(90),
    };
    const directory = { findLocalUserId: vi.fn().mockResolvedValue(2) };
    const events = { emitAsync: vi.fn().mockResolvedValue([]) };
    callTombstoneCache.clear();
    const bridge = new FederationCallBridgeService(
      {} as never,
      directory as never,
      participants as never,
      { peek: vi.fn().mockResolvedValue(undefined) } as never,
      events as never,
      {} as never,
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
