import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationNamespaceAdminService } from './federation-namespace-admin.service.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openSealedBox } from '../federation/sealed-box.js';

const ROOT_A_SECRET = Buffer.alloc(32, 1);
const ROOT_A = Buffer.from(ed25519.getPublicKey(ROOT_A_SECRET)).toString(
  'base64',
);
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
    epochMatched: true,
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
  if (statement == null) return '';
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks;
  if (chunks === undefined) {
    const value = (statement as { value?: unknown })?.value;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join('');
    return '';
  }
  return chunks.map((chunk) => sqlText(chunk)).join('');
}

function subject(
  rowsByCall: unknown[][],
  verify?: (url: URL, init: RequestInit) => Promise<Response>,
) {
  const claimedRoot =
    (rowsByCall[0]?.[0] as { claimedRoot?: string })?.claimedRoot ?? ROOT_B;
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
    {
      fetchWellKnown: vi.fn().mockResolvedValue({
        protocolVersions: [1],
        roots: [
          { ed25519: claimedRoot, notBefore: 0, notAfter: 253402300799999 },
        ],
        keys: [
          {
            keyId: 'peer.example/current',
            ed25519: ROOT_A,
            root: claimedRoot,
            notBefore: 0,
            notAfter: 253402300799999,
            authorizationSignature: Buffer.alloc(64).toString('base64'),
          },
        ],
      }),
      resolveBase: vi.fn().mockResolvedValue('https://peer.example'),
      acquireRequestSlot: vi.fn().mockResolvedValue(() => undefined),
      request: verify,
    } as never,
    { signOutbound: vi.fn().mockResolvedValue({}) } as never,
    { get: () => ({ callTimeoutSec: 12 }) } as never,
  );
  // Approval tests isolate proof orchestration from sealed-box transport.
  // The real challenge is covered by the root-rotation integration flow.
  const challengePredecessor = vi
    .spyOn(
      service as unknown as {
        challengePredecessor: (review: unknown) => Promise<{
          reviewId: number;
          checkedRoot: string;
          ok: boolean;
          detail: string;
        }>;
      },
      'challengePredecessor',
    )
    .mockResolvedValue({
      reviewId: 7,
      checkedRoot: ROOT_A,
      ok: true,
      detail: 'test proof',
    });
  return {
    service,
    challengePredecessor,
    execute,
    database,
    recordNamespaceChangeInTx,
    recordClientChangeInTx,
    scheduleRefresh,
    notifyProfileNamespaceChange,
  };
}

describe('FederationNamespaceAdminService', () => {
  it.each(['new-peer', 'replace-identity'] as const)(
    'requires an explicit reset decision and applies %s atomically',
    async (resolution) => {
      const review = reviewRow({ kind: 'identity-reset' });
      const target = subject([
        [review],
        [review],
        [namespaceRow({ trustLevel: 'halted' })],
        [{ haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH }],
      ]);
      await expect(
        target.service.approve(7, resolution),
      ).resolves.toMatchObject({
        status: 'approved',
        activeNamespaceId: resolution === 'new-peer' ? null : 12,
      });
      expect(target.challengePredecessor).not.toHaveBeenCalled();
      const statements = target.execute.mock.calls
        .map(([q]) => sqlText(q))
        .join('\n');
      if (resolution === 'new-peer') {
        expect(statements).toContain('"retiredAt" = now()');
        expect(statements).not.toContain('INSERT INTO "S2SKeyCache"');
      } else {
        expect(statements).toContain('"haltCode" = NULL');
        expect(statements).toContain('INSERT INTO "S2SKeyCache"');
      }
    },
  );

  it('does not implicitly replace a discontinuous identity', async () => {
    const target = subject([[reviewRow({ kind: 'identity-reset' })]]);
    await expect(target.service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
  });

  it('does not clear an independent administrative block during reset approval', async () => {
    const review = reviewRow({ kind: 'identity-reset' });
    const target = subject([
      [review],
      [review],
      [namespaceRow({ trustLevel: 'halted' })],
      [{ haltCode: BusinessCode.FEDERATION_PEER_BLOCKED }],
    ]);
    await expect(
      target.service.approve(7, 'replace-identity'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
  });
  it('lists namespaces and reviews for a peer domain', async () => {
    const { service, execute } = subject([[namespaceRow()], [reviewRow()]]);
    await expect(service.list('Peer.Example.')).resolves.toMatchObject({
      namespaces: [{ id: 12, rootPublicKey: ROOT_A }],
      reviews: [{ id: 7, kind: 'root-rotation' }],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('lists pending reviews across peers', async () => {
    const { service } = subject([[reviewRow()]]);
    await expect(service.pendingReviews()).resolves.toMatchObject([
      { id: 7, epochMatched: true },
    ]);
  });

  it('projects query-time identity matching without mixing in halt policy', async () => {
    const { service, execute } = subject([
      [reviewRow({ epochMatched: false })],
    ]);
    await expect(service.pendingReviews()).resolves.toMatchObject([
      { id: 7, epochMatched: false },
    ]);
    const statement = sqlText(execute.mock.calls[0]![0]);
    expect(statement).toContain('ns.active AND ns."retiredAt" IS NULL');
    expect(statement).toContain("'previousRoot'");
    expect(statement).toContain("'previousDomain'");
    expect(statement).not.toContain('"haltCode"');
    expect(statement).not.toContain('"namespaceTrustLevel"');
  });

  it('rejects a review without touching the pinned epoch', async () => {
    const {
      service,
      execute,
      recordNamespaceChangeInTx,
      recordClientChangeInTx,
      notifyProfileNamespaceChange,
      scheduleRefresh,
    } = subject([[reviewRow()], [namespaceRow()]]);
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
    expect(recordNamespaceChangeInTx).not.toHaveBeenCalled();
    expect(recordClientChangeInTx).not.toHaveBeenCalled();
    expect(notifyProfileNamespaceChange).not.toHaveBeenCalled();
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });

  it('approves a root replacement while preserving both namespace coordinates in one commit', async () => {
    const {
      service,
      execute,
      recordNamespaceChangeInTx,
      recordClientChangeInTx,
      notifyProfileNamespaceChange,
      scheduleRefresh,
    } = subject([
      [reviewRow()], // evidence captured before network I/O
      [reviewRow()], // evidence revalidated at commit
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
    expect(statements).toContain('INSERT INTO "S2SKeyCache"');
    expect(statements).toContain('THEN \'available\' ELSE "trustLevel" END');
    // The key swap is one binding change on a stable nsid: it is published on
    // the shared Profile Namespace Feed in the same commit.
    expect(recordNamespaceChangeInTx).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      12,
    );
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
    for (const column of [
      'peerAssignedLocalNamespaceId',
      'peerAcceptanceConfirmed',
      'stateFeedEndId',
      'stateFeedPulledThrough',
      'profileNamespaceFeedPulledThrough',
    ]) {
      expect(statements).not.toContain(`"${column}" =`);
    }
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
    const rebind = reviewRow({
      kind: 'domain-rebind',
      nextDomain: 'moved.example',
      claimedRoot: ROOT_A,
      claim: { previousDomain: 'peer.example' },
    });
    const {
      service,
      execute,
      recordNamespaceChangeInTx,
      challengePredecessor,
    } = subject([
      [rebind],
      [
        reviewRow({
          kind: 'domain-rebind',
          nextDomain: 'moved.example',
          claimedRoot: ROOT_A,
          claim: { previousDomain: 'peer.example' },
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
    expect(challengePredecessor).not.toHaveBeenCalled();
    expect(statements).toContain('SET domain =');
    expect(statements).not.toContain('"peerAcceptanceConfirmed" =');
    expect(statements).toContain('"remoteServiceReachable" = true');
    expect(statements).not.toContain('INSERT INTO "IdentityNamespace"');
    // The re-bind is published on the shared Profile Namespace Feed in the
    // same commit.
    expect(recordNamespaceChangeInTx).toHaveBeenCalledTimes(1);
  });

  it('does not mutate identity or review state when the predecessor challenge fails', async () => {
    const {
      service,
      execute,
      challengePredecessor,
      recordNamespaceChangeInTx,
    } = subject([[reviewRow()]]);
    challengePredecessor.mockResolvedValueOnce({
      reviewId: 7,
      checkedRoot: ROOT_A,
      ok: false,
      detail: 'peer unreachable',
    });
    await expect(service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
      status: 409,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recordNamespaceChangeInTx).not.toHaveBeenCalled();
  });

  it.each([
    { nextDomain: 'changed.example' },
    { claimedRoot: ROOT_A },
    { matchedNamespaceId: 13 },
    { claim: { previousRoot: ROOT_B, claimedRoot: ROOT_B } },
    { kind: 'domain-rebind' },
  ])('rejects proof for a changed review: %j', async (change) => {
    const { service, execute, recordNamespaceChangeInTx } = subject([
      [reviewRow()],
      [reviewRow(change)],
    ]);
    await expect(service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
      status: 409,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(recordNamespaceChangeInTx).not.toHaveBeenCalled();
  });

  it('performs the challenge outside the decision transaction', async () => {
    const { service, database, challengePredecessor } = subject([
      [reviewRow()],
      [reviewRow()],
      [namespaceRow()],
    ]);
    challengePredecessor.mockImplementationOnce(async () => {
      // The capture transaction has completed; the decision has not begun.
      expect(database.db.transaction).toHaveBeenCalledTimes(1);
      expect(database.db.transaction.mock.settledResults[0]?.type).toBe(
        'fulfilled',
      );
      return { reviewId: 7, checkedRoot: ROOT_A, ok: true, detail: 'proof' };
    });
    await expect(service.approve(7)).resolves.toMatchObject({
      status: 'approved',
    });
    expect(database.db.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(['opened', 'wrong-plaintext', 'network-error'] as const)(
    'requires a real sealed challenge on approval: %s',
    async (answer) => {
      const verify = vi.fn(async (url: URL, init: RequestInit) => {
        expect(url.href).toBe('https://peer.example/s2s/v1/verify');
        const body = JSON.parse(init.body as string) as {
          publicKey: string;
          encryptedValue: string;
        };
        expect(body.publicKey).toBe(ROOT_A);
        if (answer === 'network-error') throw new Error('connection lost');
        const plaintext = openSealedBox(
          Buffer.from(body.encryptedValue, 'base64'),
          ROOT_A_SECRET,
        );
        expect(plaintext).not.toBeNull();
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              value:
                answer === 'opened'
                  ? Buffer.from(plaintext!).toString('base64')
                  : 'wrong plaintext',
            },
          }),
          { status: 200 },
        );
      });
      const {
        service,
        execute,
        challengePredecessor,
        recordNamespaceChangeInTx,
      } = subject([[reviewRow()], [reviewRow()], [namespaceRow()]], verify);
      challengePredecessor.mockRestore();
      if (answer === 'opened') {
        await expect(service.approve(7)).resolves.toMatchObject({
          status: 'approved',
        });
        expect(recordNamespaceChangeInTx).toHaveBeenCalledOnce();
      } else {
        await expect(service.approve(7)).rejects.toMatchObject({
          bizCode: BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(recordNamespaceChangeInTx).not.toHaveBeenCalled();
      }
      expect(verify).toHaveBeenCalledOnce();
    },
  );

  it('uses a fresh challenge when retrying an approval with stale evidence', async () => {
    const nonces: string[] = [];
    const verify = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        encryptedValue: string;
      };
      const opened = openSealedBox(
        Buffer.from(body.encryptedValue, 'base64'),
        ROOT_A_SECRET,
      );
      expect(opened).not.toBeNull();
      nonces.push(Buffer.from(opened!).toString('base64'));
      return new Response(
        JSON.stringify({
          code: 0,
          data: { value: nonces[0] },
        }),
        { status: 200 },
      );
    });
    const { service, challengePredecessor, recordNamespaceChangeInTx } =
      subject(
        [
          [reviewRow()],
          [reviewRow({ nextDomain: 'changed.example' })],
          [reviewRow()],
        ],
        verify,
      );
    challengePredecessor.mockRestore();
    await expect(service.approve(7)).rejects.toMatchObject({
      message:
        'identity review changed during approval; retry with current evidence',
    });
    await expect(service.approve(7)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
    });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(recordNamespaceChangeInTx).not.toHaveBeenCalled();
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
