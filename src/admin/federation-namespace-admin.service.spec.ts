import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationNamespaceAdminService } from './federation-namespace-admin.service.js';

const ROOT_A = Buffer.alloc(32, 1).toString('base64');
const ROOT_B = Buffer.alloc(32, 2).toString('base64');

function reviewRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 7,
    kind: 'root-rotation',
    matchedNamespaceId: 12,
    matchedDomain: 'peer.example',
    nextDomain: 'peer.example',
    claimedRoot: ROOT_B,
    claim: { previousRoot: ROOT_A, claimedRoot: ROOT_B },
    status: 'pending',
    verifiedAt: new Date(),
    reviewedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function namespaceRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 12,
    domain: 'peer.example',
    rootPublicKey: ROOT_A,
    peerAssignedLocalNamespaceId: 9,
    identityPinnedAt: new Date(),
    retiredAt: null,
    active: true,
    trustLevel: 'available',
    ...overrides,
  };
}

function sqlText(statement: unknown): string {
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
  if (chunks === undefined) {
    const value = (statement as { value?: unknown })?.value;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join('');
    return '';
  }
  return chunks.map((chunk) => sqlText(chunk)).join('');
}

function subject(rowsByCall: unknown[][]) {
  const execute = vi.fn<(statement: unknown) => Promise<{ rows: unknown[] }>>(
    async () => {
      const rows = rowsByCall.shift() ?? [];
      return { rows };
    },
  );
  const database = {
    db: {
      execute,
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ execute }),
      ),
    },
  };
  const recordNamespaceChangeInTx = vi.fn();
  const recordClientChangeInTx = vi.fn(async () => 1n);
  const scheduleRefresh = vi.fn();
  const notifyProfileNamespaceChange = vi.fn();
  const service = new FederationNamespaceAdminService(
    database as never,
    {
      recordNamespaceChangeInTx,
      recordClientChangeInTx,
    } as never,
    { scheduleRefresh } as never,
    { notifyProfileNamespaceChange } as never,
  );
  return {
    service,
    execute,
    database,
    recordNamespaceChangeInTx,
    recordClientChangeInTx,
    scheduleRefresh,
    notifyProfileNamespaceChange,
  };
}

describe('FederationNamespaceAdminService', () => {
  it('lists namespaces and reviews for a peer domain', async () => {
    const { service, execute } = subject([[namespaceRow()], [reviewRow()]]);
    await expect(service.list('Peer.Example.')).resolves.toMatchObject({
      namespaces: [{ id: 12, rootPublicKey: ROOT_A }],
      reviews: [{ id: 7, kind: 'root-rotation' }],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('lists pending reviews across peers', async () => {
    const { service, execute } = subject([[reviewRow()]]);
    await expect(service.pendingReviews()).resolves.toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a review without touching the pinned epoch', async () => {
    const { service, execute } = subject([[reviewRow()], [namespaceRow()]]);
    await expect(service.reject(7)).resolves.toMatchObject({
      reviewId: 7,
      status: 'rejected',
      activeNamespaceId: 12,
    });
    const statements = execute.mock.calls
      .map((call) => sqlText(call[0]))
      .join('\n');
    expect(statements).toContain('UPDATE "FederationIdentityReview"');
    expect(statements).not.toContain('UPDATE "IdentityNamespace"');
  });

  it('approves a root replacement by swapping the pinned key on the same epoch in one commit', async () => {
    const {
      service,
      execute,
      recordNamespaceChangeInTx,
      recordClientChangeInTx,
      notifyProfileNamespaceChange,
      scheduleRefresh,
    } = subject([
      [reviewRow()],
      [namespaceRow()],
      [], // conflicting pinned-root probe
      [], // in-place root replacement
      [], // cache delete
      [], // review decision
    ]);
    await expect(service.approve(7)).resolves.toMatchObject({
      reviewId: 7,
      status: 'approved',
      activeNamespaceId: 12,
    });
    const statements = execute.mock.calls
      .map((call) => sqlText(call[0]))
      .join('\n');
    expect(statements).toContain('UPDATE "IdentityNamespace"');
    expect(statements).toContain('SET "rootPublicKey" = ');
    expect(statements).toContain('"identityPinnedAt" = now()');
    expect(statements).toContain('DELETE FROM "S2SKeyCache"');
    // The key swap is one binding change on a stable nsid: it is published on
    // the shared Profile Namespace Feed in the same commit.
    expect(recordNamespaceChangeInTx).toHaveBeenCalledTimes(1);
    // The client change feed records the pair in the same commit; devices
    // wake on the allocated position after commit, and the local
    // authoritative row converges then too.
    expect(recordClientChangeInTx).toHaveBeenCalledWith(expect.anything(), {
      publisherNamespaceId: 12,
      profileNamespaceId: 0,
    });
    expect(notifyProfileNamespaceChange).toHaveBeenCalledWith(1n);
    expect(scheduleRefresh).toHaveBeenCalledWith(
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
      0n,
    );
    // A root replacement keeps the lifelong nsid: no successor epoch row is
    // created, the epoch is never retired, and business facts bound to the
    // id stay in place without any carry-over rewrite.
    expect(statements).not.toContain('INSERT INTO "IdentityNamespace"');
    expect(statements).not.toContain('"retiredAt" = now()');
    for (const table of [
      'Message',
      'RelationshipPair',
      'PeerStateFeed',
      'FederationThreadSyncState',
    ]) {
      expect(statements).not.toContain(`UPDATE "${table}"`);
    }
  });

  it('approves a domain re-bind by moving the epoch to the arrival domain', async () => {
    const { service, execute, recordNamespaceChangeInTx } = subject([
      [
        reviewRow({
          kind: 'domain-rebind',
          nextDomain: 'moved.example',
          claimedRoot: ROOT_A,
          claim: {},
        }),
      ],
      [namespaceRow()],
      [], // conflicting active-domain probe
      [], // re-bind update
      [], // cache delete
      [], // review decision
    ]);
    await expect(service.approve(7)).resolves.toMatchObject({
      status: 'approved',
      activeNamespaceId: 12,
      domain: 'moved.example',
    });
    const statements = execute.mock.calls
      .map((call) => sqlText(call[0]))
      .join('\n');
    expect(statements).toContain('SET domain =');
    expect(statements).not.toContain('INSERT INTO "IdentityNamespace"');
    // The re-bind is published on the shared Profile Namespace Feed in the
    // same commit.
    expect(recordNamespaceChangeInTx).toHaveBeenCalledTimes(1);
  });

  it('refuses to decide a review twice', async () => {
    const { service } = subject([
      [reviewRow({ status: 'approved', reviewedAt: new Date() })],
    ]);
    await expect(service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
      status: 409,
    });
  });

  it('refuses a rotation whose epoch no longer matches the reviewed evidence', async () => {
    const { service } = subject([
      [reviewRow()],
      [namespaceRow({ rootPublicKey: ROOT_B })],
    ]);
    await expect(service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
      status: 409,
    });
  });

  it('refuses a rotation approval when the claimed root is already pinned', async () => {
    const { service } = subject([
      [reviewRow()],
      [namespaceRow()],
      [{ id: 99 }], // conflicting pinned-root probe
    ]);
    await expect(service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_DOMAIN_CONFLICT,
      status: 409,
    });
  });
});
