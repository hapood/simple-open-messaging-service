import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import {
  federationIdentityReview,
  identityNamespace,
  localFederationRoot,
  localFederationSigningKey,
  localFederationSigningState,
  profileNamespaceFeed,
} from '../src/database/schema.js';
import { SignatureService } from '../src/federation/signature.service.js';
import { assertFederationWireSchema } from './support/federation-wire-schema.js';
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
 *      per node) must stay satisfied at commit time.
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
  let adminCookieA: string;
  let adminCookieB: string;
  let peerNamespaceId: number;
  let peerAssignedLocalNamespaceId: number;
  let namespaceFeedId: bigint;
  let pinnedRootBeforeRotation: string;
  let previousRootId: number;
  let newRootId: number;
  let newRootPublicKey: string;

  async function signedRequest(
    sender: FedApp,
    recipient: FedApp,
    path: string,
    payload?: { namespaceId: number },
  ) {
    const [key] = await sender.database
      .select({
        keyName: localFederationSigningKey.keyName,
        domain: identityNamespace.domain,
        privateKey: localFederationSigningKey.privateKey,
        rootPublicKey: localFederationRoot.rootPublicKey,
      })
      .from(localFederationSigningState)
      .innerJoin(
        localFederationSigningKey,
        eq(
          localFederationSigningKey.keyName,
          localFederationSigningState.currentKeyName,
        ),
      )
      .innerJoin(
        localFederationRoot,
        eq(localFederationRoot.id, localFederationSigningKey.rootId),
      )
      .innerJoin(identityNamespace, eq(identityNamespace.id, 0));
    if (!key) throw new Error('test sender has no active signing key');
    const signer = new SignatureService({
      getKeyId: () => `${key.domain}/${key.keyName}`,
      getPrivateKey: () => Buffer.from(key.privateKey, 'base64'),
      getRootPublicKeyB64: () => key.rootPublicKey,
    } as never);
    const method = payload === undefined ? 'GET' : 'POST';
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const url = new URL(path, recipient.baseUrl);
    const headers = await signer.signOutbound({ method, url, body });
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(payload === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

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
    await registerAndLogin(appB, 'root-rotate-bob', 'Root Rotate Bob');
    adminCookieA = await getAdminCookie(appA);
    adminCookieB = await getAdminCookie(appB);

    await resolveResolved();
    const row = await peerRowOnA();
    expect(row).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
    });
    peerNamespaceId = row!.id;
    expect(row!.peerAssignedLocalNamespaceId).toBeGreaterThan(0);
    peerAssignedLocalNamespaceId = row!.peerAssignedLocalNamespaceId!;
    pinnedRootBeforeRotation = row!.rootPublicKey!;
    const initialNamespaceItem =
      await appA.database.query.profileNamespaceFeed.findFirst({
        where: eq(profileNamespaceFeed.namespaceId, peerNamespaceId),
      });
    expect(initialNamespaceItem).toBeDefined();
    namespaceFeedId = initialNamespaceItem!.feedId;

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

  it('rotates the root epoch while keeping exactly one claimable local root', async () => {
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
        where: eq(localFederationSigningKey.keyName, state[0]!.currentKeyName),
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

    expect(await peerRowOnA()).toMatchObject({
      id: peerNamespaceId,
      rootPublicKey: pinnedRootBeforeRotation,
      peerAssignedLocalNamespaceId,
      retiredAt: null,
    });

    // Approval performs the predecessor possession challenge automatically.
    const approval = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/identity-reviews/${review!.id}/approve`)
      .set('Cookie', adminCookieA);
    expect(approval.status).toBe(200);
    expect(approval.body.code).toBe(0);
    expect(approval.body.data.activeNamespaceId).toBe(peerNamespaceId);
    expect(await peerRowOnA()).toMatchObject({
      peerAcceptanceConfirmed: true,
      rootPublicKey: newRootPublicKey,
      trustLevel: 'available',
    });
    const approvedHealth = await signedRequest(appB, appA, '/s2s/v1/health');
    expect(approvedHealth).toEqual({
      code: 0,
      message: 'successful',
      data: {
        status: 'available',
        peerAssignedLocalNamespaceId: peerNamespaceId,
      },
    });
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
    expect(converged).toMatchObject({
      peerAcceptanceConfirmed: true,
      peerAssignedLocalNamespaceId,
      retiredAt: null,
    });
    const reversePeer = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(reversePeer).toMatchObject({
      id: peerAssignedLocalNamespaceId,
      peerAssignedLocalNamespaceId: peerNamespaceId,
      retiredAt: null,
    });
    const namespacesForB = await appA.database.query.identityNamespace.findMany(
      {
        where: eq(identityNamespace.domain, FED_DOMAIN_B),
      },
    );
    expect(namespacesForB.map((namespace) => namespace.id)).toEqual([
      peerNamespaceId,
    ]);

    // Ordinary traffic works with the certificates installed at approval,
    // without requiring a new reciprocal Recognize or a discovery side effect.
    const feed = await signedRequest(
      appB,
      appA,
      '/s2s/v1/profile-namespace-feed',
    );
    expect(feed.code).toBe(0);
    assertFederationWireSchema(
      'urn:somfp:v1:profile-namespace-feed',
      feed.data,
    );

    // Recognition and Health disclose the same namespace after key succession.
    const recognized = await signedRequest(appB, appA, '/s2s/v1/recognize', {
      namespaceId: peerAssignedLocalNamespaceId,
    });
    assertFederationWireSchema(
      'urn:somfp:v1:identity#/$defs/recognizeResult',
      recognized.data,
    );
    assertFederationWireSchema(
      'urn:somfp:v1:common#/$defs/successEnvelope',
      recognized,
    );
    expect(recognized).toEqual({
      code: 0,
      message: 'successful',
      data: {
        status: 'recognized',
        peerAssignedLocalNamespaceId: peerNamespaceId,
      },
    });
    const health = await signedRequest(appB, appA, '/s2s/v1/health');
    assertFederationWireSchema(
      'urn:somfp:v1:identity#/$defs/healthResult',
      health.data,
    );
    assertFederationWireSchema(
      'urn:somfp:v1:common#/$defs/successEnvelope',
      health,
    );
    expect(health).toMatchObject({
      data: { peerAssignedLocalNamespaceId: peerNamespaceId },
    });
    expect(['available', 'degraded']).toContain(health.data.status);

    const item = feed.data.items.find(
      (entry: { namespaceId: number }) => entry.namespaceId === peerNamespaceId,
    );
    expect(item).toBeDefined();
    expect(BigInt(item.feedId)).toBeGreaterThan(namespaceFeedId);
    const ownFeed = await signedRequest(
      appA,
      appB,
      '/s2s/v1/profile-namespace-feed',
    );
    expect(ownFeed.code).toBe(0);
    assertFederationWireSchema(
      'urn:somfp:v1:profile-namespace-feed',
      ownFeed.data,
    );
    expect(ownFeed.data.items).toContainEqual({
      namespaceId: 0,
      feedId: expect.stringMatching(/^[1-9][0-9]*$/),
    });

    for (const [sender, publisher, namespaceId] of [
      [appB, appA, peerNamespaceId],
      [appA, appB, 0],
    ] as const) {
      const bindings = await signedRequest(
        sender,
        publisher,
        `/s2s/v1/profile-namespaces/${namespaceId}`,
      );
      expect(bindings.code).toBe(0);
      assertFederationWireSchema(
        'urn:somfp:v1:profile-namespace',
        bindings.data,
      );
      expect(bindings.data).toMatchObject({
        domain: FED_DOMAIN_B,
        rootPublicKey: newRootPublicKey,
      });
      if (namespaceId === peerNamespaceId) {
        expect(
          BigInt(bindings.data.profileNamespaceFeedEndId),
        ).toBeGreaterThanOrEqual(BigInt(item.feedId));
      }
    }

    // The user plane recovers through the rotated identity.
    await resolveResolved();
  });
});
