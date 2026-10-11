import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import {
  federationIdentityReview,
  identityNamespace,
  localFederationRoot,
  localFederationSigningKey,
  localFederationSigningState,
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
 * End-to-end coverage of an immediate root-epoch rotation through the real
 * admin HTTP surface on a REAL database-backed keypair
 * (FED_E2E_REAL_KEYPAIR=1):
 *
 *   1. alice@aaa.test resolves bob@bbb.test — recognition is confirmed on both peers.
 *   2. A SUPER_ADMIN rotates appB's local federation root epoch
 *      (/admin/federation/local-root-epochs/rotate). The rotation shares one
 *      transaction with the previous epoch's claim release, so the partial
 *      unique index LocalFederationRoot_one_claimable_key (one claimable root
 *      per domain) must stay satisfied at commit time.
 *   3. appB re-recognizes appA; appA quarantines the arrival as a pending
 *      'root-rotation' review claiming the new root.
 *   4. The predecessor check proves continuity (the peer still possesses the
 *      pinned predecessor root), a SUPER_ADMIN approves, and recognition
 *      converges: appA keeps the namespace id but re-pins the new root.
 *   5. Federated user resolution works again through the rotated identity.
 */
async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false)
        return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${what}${detail}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('database-backed root-epoch rotation', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceToken: string;
  let bobToken: string;
  let adminCookieA: string;
  let adminCookieB: string;
  let peerNamespaceId: number;
  let previousRootId: number;
  let newRootId: number;
  let newRootPublicKey: string;

  function recognizeFromB() {
    return request(appB.baseUrl)
      .post(
        `/api/v1/admin/federation/peers/${encodeURIComponent(FED_DOMAIN_A)}/recognize`,
      )
      .set('Cookie', adminCookieB);
  }

  function peerRowOnA() {
    return appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_B),
        eq(identityNamespace.active, true),
      ),
    });
  }

  function pendingRootRotationReviewOnA() {
    return appA.database.query.federationIdentityReview.findFirst({
      where: and(
        eq(federationIdentityReview.kind, 'root-rotation'),
        eq(federationIdentityReview.nextDomain, FED_DOMAIN_B),
        eq(federationIdentityReview.status, 'pending'),
      ),
    });
  }

  /** Resolve alice→bob, retrying transient failures (inbound Recognize
   *  verification is asynchronous, so the first response can be `pending`). */
  async function resolveResolved(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const card = await resolveFederatedCard(
        appA,
        aliceToken,
        'root-rotate-bob',
        FED_DOMAIN_B,
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
    }));
    ({ token: aliceToken } = await registerAndLogin(
      appA,
      'root-rotate-alice',
      'Root Rotate Alice',
    ));
    ({ token: bobToken } = await registerAndLogin(
      appB,
      'root-rotate-bob',
      'Root Rotate Bob',
    ));
    adminCookieA = await getAdminCookie(appA);
    adminCookieB = await getAdminCookie(appB);

    await resolveResolved();
    const row = await peerRowOnA();
    expect(row).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
    });
    peerNamespaceId = row!.id;

    const bootstrapRoots = await appB.database
      .select()
      .from(localFederationRoot);
    expect(
      bootstrapRoots.filter((root) => root.claimable).length,
    ).toBeGreaterThanOrEqual(1);
  }, 180_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('rotates the root epoch while keeping exactly one claimable root per domain', async () => {
    const response = await request(appB.baseUrl)
      .post('/api/v1/admin/federation/local-root-epochs/rotate')
      .set('Cookie', adminCookieB);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(response.body.data).toMatchObject({
      previousRootId: expect.any(Number),
      newRootId: expect.any(Number),
      newRootPublicKey: expect.any(String),
      clientChangeId: expect.stringMatching(/^[1-9][0-9]*$/),
    });
    previousRootId = response.body.data.previousRootId;
    newRootId = response.body.data.newRootId;
    newRootPublicKey = response.body.data.newRootPublicKey;
    expect(newRootId).not.toBe(previousRootId);

    const roots = await appB.database
      .select()
      .from(localFederationRoot)
      .orderBy(localFederationRoot.id);
    const claimable = roots.filter((root) => root.claimable);
    expect(claimable).toHaveLength(1);
    expect(claimable[0]!.id).toBe(newRootId);
    expect(claimable[0]!.rootPublicKey).toBe(newRootPublicKey);
    const previous = roots.find((root) => root.id === previousRootId);
    expect(previous?.claimable).toBe(false);

    // The active signing certificate must already belong to the new epoch.
    const state = await appB.database
      .select()
      .from(localFederationSigningState)
      .limit(1);
    const activeKey =
      await appB.database.query.localFederationSigningKey.findFirst({
        where: eq(localFederationSigningKey.keyId, state[0]!.currentKeyId),
      });
    expect(activeKey?.rootId).toBe(newRootId);
  });

  it('quarantines the rotated root as a pending review and approves it after the predecessor check', async () => {
    await recognizeFromB();
    const review = await waitFor(
      pendingRootRotationReviewOnA,
      60_000,
      `pending root-rotation review for ${FED_DOMAIN_B} on ${FED_DOMAIN_A}`,
    );
    expect(review).toMatchObject({
      matchedNamespaceId: peerNamespaceId,
      claimedRoot: newRootPublicKey,
      kind: 'root-rotation',
    });

    const continuity = await request(appA.baseUrl)
      .post(
        `/api/v1/admin/federation/identity-reviews/${review!.id}/predecessor-check`,
      )
      .set('Cookie', adminCookieA);
    expect(continuity.status).toBe(200);
    expect(continuity.body.code).toBe(0);
    expect(continuity.body.data.ok, continuity.body.data.detail).toBe(true);

    const approval = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/identity-reviews/${review!.id}/approve`)
      .set('Cookie', adminCookieA);
    expect(approval.status).toBe(200);
    expect(approval.body.code).toBe(0);

    await recognizeFromB();
    const converged = await waitFor(
      async () => {
        const row = await peerRowOnA();
        return row?.trustLevel === 'available' &&
          row?.rootPublicKey === newRootPublicKey &&
          row?.id === peerNamespaceId
          ? row
          : undefined;
      },
      60_000,
      `${FED_DOMAIN_B} to re-converge on the rotated root`,
    );
    expect(converged).toMatchObject({ peerAcceptanceConfirmed: true });

    // The user plane recovers through the rotated identity.
    await resolveResolved();
  });
});
