import { describe, expect, it, vi } from 'vitest';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { FEDERATION_PEER_AVAILABLE } from './federation-peer.events.js';

process.env.SOMS_DOMAIN = 'local.example';

type PeerPatch = Record<string, unknown>;

/** Minimal fake transaction covering lockPeer's FOR NO KEY UPDATE select and the
 *  plain update/insert used by markTransportDegraded. Awaited chains resolve to
 *  the captured peer row (select) or to undefined (update/insert). */
function fakeDatabase(peer: Record<string, unknown> | undefined) {
  const patches: PeerPatch[] = [];
  const events: Array<Record<string, unknown>> = [];
  const selectRows = Promise.resolve(peer ? [peer] : []);
  const tx = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            for: () => ({
              limit: () => selectRows,
            }),
          }),
        }),
        where: () => ({
          for: () => ({
            limit: () => selectRows,
          }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: PeerPatch) => ({
        where: () => {
          patches.push(patch);
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        events.push(value);
        return Promise.resolve(undefined);
      },
    }),
  };
  return {
    database: {
      db: {
        query: { identityNamespace: { findFirst: async () => peer } },
        transaction: (run: (tx: unknown) => Promise<void>) =>
          run(tx) as Promise<void>,
      },
    } as never,
    patches,
    events,
  };
}

/** An 'available' peer: recognition, acceptance, and reachability all proven. */
function availablePeer() {
  return {
    rootPublicKey: 'root-a',
    domain: 'peer.example',
    trustLevel: 'available',
    localServiceAvailable: true,
    peerAcceptanceConfirmed: true,
    remoteServiceReachable: true,
    lastSuccessAt: null,
    identityPinnedAt: new Date(),
    active: true,
    id: 12,
  };
}

function service(
  peer: Record<string, unknown> | undefined,
  status: number,
): {
  recognition: FederationRecognitionService;
  patches: PeerPatch[];
  events: Array<Record<string, unknown>>;
  request: ReturnType<typeof vi.fn>;
  emitted: ReturnType<typeof vi.fn>;
} {
  const { database, patches, events } = fakeDatabase(peer);
  const request = vi.fn().mockResolvedValue({ status });
  const emitter = { emit: vi.fn() };
  const recognition = new FederationRecognitionService(
    database,
    {
      resolveBase: () => Promise.resolve('https://peer.example'),
      acquireRequestSlot: () => Promise.resolve(() => undefined),
      request,
    } as never,
    { signOutbound: () => Promise.resolve({}) } as never,
    { get: () => ({ callTimeoutSec: 5 }) } as never,
    {} as never,
    emitter as never,
  );
  return { recognition, patches, events, request, emitted: emitter.emit };
}

describe('FederationRecognitionService outbound Health failure mapping', () => {
  it('maps HTTP 401 to degraded, never halted, and never repairs the peer cache', async () => {
    const { recognition, patches, request } = service(availablePeer(), 401);

    await expect(recognition.checkHealth('peer.example')).rejects.toThrow(
      'returned HTTP 401',
    );

    expect(request).toHaveBeenCalledOnce();
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({
      trustLevel: 'degraded',
      remoteServiceReachable: false,
      degradationReason: 'Health HTTP 401',
    });
  });

  it('still maps HTTP 503 to degraded after unifying the non-200 branch', async () => {
    const { recognition, patches } = service(availablePeer(), 503);

    await expect(recognition.checkHealth('peer.example')).rejects.toThrow(
      'returned HTTP 503',
    );
    expect(patches[0]).toMatchObject({
      trustLevel: 'degraded',
      remoteServiceReachable: false,
      degradationReason: 'Health HTTP 503',
    });
  });

  it('keeps acceptance evidence and only clears reachability when the peer is degraded by a non-200', async () => {
    const peer = { ...availablePeer(), trustLevel: 'degraded' };
    const { recognition, patches, events } = service(peer, 401);

    await expect(recognition.checkHealth('peer.example')).rejects.toThrow(
      'returned HTTP 401',
    );
    expect(patches[0]).toMatchObject({
      trustLevel: 'degraded',
      remoteServiceReachable: false,
    });
    // No re-degradation audit event: the peer was already degraded, not transitioned.
    expect(events).toHaveLength(0);
  });
});

describe('FederationRecognitionService contact recovery availability event', () => {
  it('emits FEDERATION_PEER_AVAILABLE once a user-visible contact restores a degraded peer', async () => {
    const peer = {
      ...availablePeer(),
      trustLevel: 'degraded',
      remoteServiceReachable: false,
      degradedAt: new Date(),
    };
    const { recognition, patches, emitted } = service(peer, 200);

    await recognition.markReachable('peer.example');

    expect(patches[0]).toMatchObject({
      trustLevel: 'available',
      remoteServiceReachable: true,
      degradedAt: null,
    });
    expect(emitted).toHaveBeenCalledExactlyOnceWith(FEDERATION_PEER_AVAILABLE, {
      peerDomain: 'peer.example',
    });
  });

  it('does not emit for an already-available or unknown peer', async () => {
    const healthy = service(availablePeer(), 200);
    await healthy.recognition.markReachable('peer.example');
    expect(healthy.emitted).not.toHaveBeenCalled();

    const unknown = service(undefined, 200);
    await unknown.recognition.markReachable('peer.example');
    expect(unknown.emitted).not.toHaveBeenCalled();
    expect(unknown.patches).toHaveLength(0);
  });
});
