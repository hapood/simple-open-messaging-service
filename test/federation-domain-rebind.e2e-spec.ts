import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import {
  identityNamespace,
  federationIdentityReview,
} from '../src/database/schema.js';

import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  getAdminCookie,
  registerAndLogin,
  resolveFederatedCard,
} from './federation-test-helpers.js';

/**
 * End-to-end coverage of a COMPLETED handshake whose peer then changes its domain:
 * the peer keeps its database (same root identity), rebinds SOMS_DOMAIN, and re-announces
 * itself. The receiving side must never silently trust the new name:
 *
 *   1. alice@aaa.test resolves bob@bbb.test — recognition is confirmed on both peers.
 *   2. appB restarts with SOMS_DOMAIN=new-bbb.test — rebindLocalDomainInTx keeps the root
 *      epoch and issues a fresh domain-bound signing certificate.
 *   3. appB's Recognize from the new domain is quarantined as a pending domain-rebind
 *      review; ordinary data-plane traffic from the new domain stays 401.
 *   4. A super-admin approves the review through the real admin HTTP surface — the epoch
 *      keeps its nsid, root pin, and sender-assigned coordinate, only the binding moves.
 *   5. Recognition converges again and user resolution works through the new domain.
 *
 * This spec runs the REAL database-backed keypair (FED_E2E_REAL_KEYPAIR=1): the rebind
 * path lives in KeypairService.bootstrapOrLoad, which the in-memory fake bypasses.
 */
const FED_DOMAIN_B_NEW = 'new-bbb.test';

interface PinnedEpoch {
  namespaceId: number;
  rootPublicKey: string;
  peerAssignedLocalNamespaceId: number | null;
}

async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('peer domain re-binding after a completed handshake', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceToken: string;
  let bobToken: string;
  let adminCookieB: string;
  let pinned: PinnedEpoch;
  let reviewId: number;

  /** Ask appB's real admin surface to start its production recognition flow. */
  function recognizeFromB() {
    return request(appB.baseUrl)
      .post(
        `/api/v1/admin/federation/peers/${encodeURIComponent(FED_DOMAIN_A)}/recognize`,
      )
      .set('Cookie', adminCookieB);
  }

  async function resolveFromB() {
    return resolveFederatedCard(appB, bobToken, 'rebind-alice', FED_DOMAIN_A);
  }

  function peerRowOnA(domain: string) {
    return appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, domain),
        eq(identityNamespace.active, true),
      ),
    });
  }

  function reviewOnA() {
    return appA.database.query.federationIdentityReview.findFirst({
      where: eq(federationIdentityReview.nextDomain, FED_DOMAIN_B_NEW),
      orderBy: (row, { desc }) => desc(row.id),
    });
  }

  /** Resolve alice→bob, retrying transient failures (inbound Recognize verification is
   *  asynchronous at HEAD, so the first response can still be `pending`). */
  async function resolveResolved(domain: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const card = await resolveFederatedCard(
        appA,
        aliceToken,
        'rebind-bob',
        domain,
      );
      if (card.event === 'resolved') return;
      const transient =
        card.event === 'failed' &&
        (card.data.reason === 'UNREACHABLE' || card.data.reason === 'TIMEOUT');
      if (!transient || attempt >= 10)
        throw new Error(
          `federated card lookup failed: ${JSON.stringify(card.data)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair({
      env: { FED_E2E_REAL_KEYPAIR: '1' },
      // The post-re-bind domain must be routable from the start: appA never restarts,
      // and both subprocesses read the route map at boot.
      extraRoutesOnB: [FED_DOMAIN_B_NEW],
    }));
    ({ token: aliceToken } = await registerAndLogin(
      appA,
      'rebind-alice',
      'Rebind Alice',
    ));
    ({ token: bobToken } = await registerAndLogin(
      appB,
      'rebind-bob',
      'Rebind Bob',
    ));
    adminCookieB = await getAdminCookie(appB);

    // 1. Complete handshake under the original domain.
    await resolveResolved(FED_DOMAIN_B);
    const row = await peerRowOnA(FED_DOMAIN_B);
    expect(row).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
    });
    pinned = {
      namespaceId: row!.id,
      rootPublicKey: row!.rootPublicKey!,
      peerAssignedLocalNamespaceId: row!.peerAssignedLocalNamespaceId,
    };
    // The namespace id B's local store allocated for A — the coordinate B must keep
    // disclosing in its re-bind arrival.
    const bRow = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(bRow).toMatchObject({ peerAcceptanceConfirmed: true });
  }, 180_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('re-binds the local domain on restart while keeping the root identity', async () => {
    await appB.restart({ domain: FED_DOMAIN_B_NEW });

    const response = await fetch(
      `http://127.0.0.1:${appB.port}/.well-known/somfp`,
      { headers: { accept: 'application/json' } },
    );
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      roots: Array<{ ed25519: string }>;
      keys: Array<{ keyId: string }>;
    };
    // Fresh certificates are bound to the NEW domain (keyId is domain-bound), while the
    // root epoch — the pinned identity — is unchanged.
    expect(doc.keys.length).toBeGreaterThanOrEqual(1);
    for (const key of doc.keys)
      expect(key.keyId.startsWith(`${FED_DOMAIN_B_NEW}/`)).toBe(true);
    expect(
      doc.roots.some((root) => root.ed25519 === pinned.rootPublicKey),
    ).toBe(true);

    // The receiver's pin is untouched by the peer's rename.
    expect(await peerRowOnA(FED_DOMAIN_B)).toMatchObject({
      rootPublicKey: pinned.rootPublicKey,
      peerAcceptanceConfirmed: true,
    });
  }, 120_000);

  it('quarantines a Recognize from the new domain as a pending re-bind review', async () => {
    const arrival = await recognizeFromB();
    expect(arrival.status).toBe(200);
    expect(arrival.body.code).toBe(0);
    expect(arrival.body.data).toMatchObject({
      domain: FED_DOMAIN_A,
      status: 'pending',
    });

    const review = await waitFor(
      async () => {
        const row = await reviewOnA();
        return row?.status === 'pending' ? row : undefined;
      },
      15_000,
      'the pending domain-rebind review',
    );
    reviewId = review.id;
    expect(review).toMatchObject({
      kind: 'domain-rebind',
      matchedNamespaceId: pinned.namespaceId,
      claimedRoot: pinned.rootPublicKey,
    });

    // The matched epoch moves to the pending lifecycle: acceptance evidence is
    // quarantined, not silently carried over to the new name.
    expect(await peerRowOnA(FED_DOMAIN_B)).toMatchObject({
      trustLevel: 'pending',
      peerAcceptanceConfirmed: false,
    });

    expect(await resolveFromB()).toEqual({
      event: 'failed',
      data: { reason: 'UNREACHABLE' },
    });
  }, 60_000);

  it('admin approval re-binds the epoch and converges recognition', async () => {
    const cookie = await getAdminCookie(appA);
    const approved = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/identity-reviews/${reviewId}/approve`)
      .set('Cookie', cookie);
    expect(approved.body.code).toBe(0);

    const reboundAttempt = await recognizeFromB();
    expect(reboundAttempt.status).toBe(200);
    expect(reboundAttempt.body.code).toBe(0);

    const rebound = await waitFor(
      async () => {
        const row = await peerRowOnA(FED_DOMAIN_B_NEW);
        return row?.trustLevel === 'available' ? row : undefined;
      },
      30_000,
      'the re-bound epoch to converge to available',
    );
    expect(rebound).toMatchObject({
      id: pinned.namespaceId,
      rootPublicKey: pinned.rootPublicKey,
      peerAssignedLocalNamespaceId: pinned.peerAssignedLocalNamespaceId,
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
    });
    // The old binding is gone — one live epoch per root, now under the new name.
    expect(await peerRowOnA(FED_DOMAIN_B)).toBeUndefined();
    expect(await reviewOnA()).toMatchObject({ status: 'approved' });

    const retry = await recognizeFromB();
    expect(retry.status).toBe(200);
    expect(retry.body.code).toBe(0);
    expect(retry.body.data).toMatchObject({
      domain: FED_DOMAIN_A,
      status: 'recognized',
    });

    const resolved = await waitFor(
      async () => {
        const result = await resolveFromB();
        return result.event === 'resolved' ? result : undefined;
      },
      30_000,
      'ordinary data-plane resolution after re-bind approval',
    );
    expect(resolved.event).toBe('resolved');
  }, 60_000);

  it('serves user resolution through the new domain', async () => {
    await resolveResolved(FED_DOMAIN_B_NEW);
  }, 60_000);
});
