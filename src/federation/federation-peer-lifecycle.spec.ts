import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { BusinessCode } from '../common/business-code.js';
import { FederationTransportError } from './federation-errors.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

process.env.SOMS_DOMAIN ??= 'local.example';

function subject(peer: Record<string, unknown> | undefined) {
  const recognition = {
    recognize: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    db: {
      query: {
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue(peer),
        },
      },
    },
  };
  return {
    lifecycle: new FederationPeerLifecycle(
      database as never,
      recognition as never,
      {} as never,
    ),
    recognition,
  };
}

describe('FederationPeerLifecycle recognition and reachability gates', () => {
  it('uses the same remote-only predicate for page data and total', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockResolvedValue([{ value: 0 }]);
    const database = {
      db: {
        query: { identityNamespace: { findMany } },
        select: () => ({ from: () => ({ where }) }),
      },
    };
    const lifecycle = new FederationPeerLifecycle(
      database as never,
      {} as never,
      {} as never,
    );
    await expect(
      lifecycle.list({
        skip: 20,
        take: 20,
        search: 'local',
        status: 'unrecognized',
        namespaceId: 0,
      }),
    ).resolves.toEqual({ list: [], total: 0 });
    const predicate = findMany.mock.calls[0][0].where;
    expect(where).toHaveBeenCalledWith(predicate);
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"IdentityNamespace"."id" >');
    expect(query.params[0]).toBe(0);
    expect(findMany.mock.calls[0][0]).toMatchObject({ offset: 20, limit: 20 });
  });
  it('rejects local namespace detail and local block/unblock operations', async () => {
    const { lifecycle } = subject({ id: 0, domain: 'local.example' });
    await expect(lifecycle.detail('local.example')).rejects.toMatchObject({
      bizCode: BusinessCode.NOT_FOUND,
    });
    await expect(lifecycle.markBlocked('local.example')).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
    await expect(
      lifecycle.markUnblocked('local.example'),
    ).rejects.toMatchObject({ bizCode: BusinessCode.VALIDATION_FAILED });
  });
  it('reports complete recognition independently of degraded reachability', async () => {
    const { lifecycle } = subject({
      trustLevel: 'degraded',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    await expect(
      lifecycle.hasCompleteRecognition('peer.example'),
    ).resolves.toBe(true);
  });

  it('does not report complete recognition while peer acceptance is unproven', async () => {
    const { lifecycle } = subject({
      trustLevel: 'establishing',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: false,
    });
    await expect(
      lifecycle.hasCompleteRecognition('peer.example'),
    ).resolves.toBe(false);
  });

  it('blocks ordinary outbound traffic while a recognized peer is degraded', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'degraded',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toBeInstanceOf(FederationTransportError);
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('rejects without starting recognition while peer acceptance is unproven', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'establishing',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: false,
    });
    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 401,
    });
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('allows outbound traffic when acceptance and reachability are proven', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'available',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).resolves.toBeUndefined();
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('retries recognition only for an establishing peer', async () => {
    const { lifecycle, recognition } = subject({ trustLevel: 'establishing' });
    await lifecycle.recoverPeerRecognition('peer.example');
    expect(recognition.recognize).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
  });

  it('does not retry recognition for an available peer', async () => {
    const { lifecycle, recognition } = subject({ trustLevel: 'available' });
    await expect(
      lifecycle.recoverPeerRecognition('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 409,
    });
    expect(recognition.recognize).not.toHaveBeenCalled();
  });
});
