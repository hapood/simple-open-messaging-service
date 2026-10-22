import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import {
  federationIdentityReview,
  identityNamespace,
  localFederationSigningKey,
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

const NEW_DOMAIN = 'rotated-bbb.test';

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('timed out waiting for federation transition');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('federation domain and signing-certificate rotation together', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceToken: string;
  let adminCookieA: string;
  let reviewId: number;
  let oldNamespaceId: number;
  let oldRoot: string;
  let oldSigningKey: string;

  async function resolve(domain: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await resolveFederatedCard(
        appA,
        aliceToken,
        'combined-bob',
        domain,
      );
      if (result.event === 'resolved') return result;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error(`federated resolution did not recover for ${domain}`);
  }

  function peer(domain: string) {
    return appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, domain),
        eq(identityNamespace.active, true),
      ),
    });
  }

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair({
      env: {
        FED_E2E_REAL_KEYPAIR: '1',
        SOMS_FEDERATION_SIGNING_KEY_LIFETIME_MS: '120000',
        SOMS_FEDERATION_SUCCESSOR_PREPUBLICATION_MS: '20000',
        SOMS_FEDERATION_PREDECESSOR_RETENTION_MS: '20000',
        SOMS_FEDERATION_CLOCK_SKEW_BUDGET_MS: '2000',
        SOMS_FEDERATION_KEY_REFRESH_POLL_MS: '2000',
      },
      extraRoutesOnB: [NEW_DOMAIN],
    }));
    ({ token: aliceToken } = await registerAndLogin(
      appA,
      'combined-alice',
      'Combined Alice',
    ));
    await registerAndLogin(appB, 'combined-bob', 'Combined Bob');
    await resolve(FED_DOMAIN_B);
    const original = await peer(FED_DOMAIN_B);
    expect(original).toBeDefined();
    oldNamespaceId = original!.id;
    oldRoot = original!.rootPublicKey!;
    const originalDocument = await fetch(
      `http://127.0.0.1:${appB.port}/.well-known/somfp`,
    ).then(
      (response) =>
        response.json() as Promise<{ keys: Array<{ ed25519: string }> }>,
    );
    oldSigningKey = originalDocument.keys[0]!.ed25519;
    adminCookieA = await getAdminCookie(appA);
  }, 180_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('requires domain approval even when independent key-expiry recovery changes the signing key', async () => {
    // Force an independent lifecycle event. Renaming alone must never generate keys.
    await appB.stop();
    await appB.database
      .update(localFederationSigningKey)
      .set({ notAfter: new Date() })
      .where(eq(localFederationSigningKey.publicKey, oldSigningKey));
    await appB.restart({ domain: NEW_DOMAIN });
    const document = await fetch(
      `http://127.0.0.1:${appB.port}/.well-known/somfp`,
    ).then(
      (response) =>
        response.json() as Promise<{
          roots: Array<{ ed25519: string }>;
          keys: Array<{ keyId: string; root: string; ed25519: string }>;
        }>,
    );
    expect(document.roots.some(({ ed25519 }) => ed25519 === oldRoot)).toBe(
      true,
    );
    expect(document.keys.length).toBeGreaterThan(0);
    expect(
      document.keys.every(({ keyId }) => keyId.startsWith(`${NEW_DOMAIN}/`)),
    ).toBe(true);
    expect(document.keys.every(({ root }) => root === oldRoot)).toBe(true);
    expect(
      document.keys.every(({ ed25519 }) => ed25519 !== oldSigningKey),
    ).toBe(true);

    const recognition = await request(appB.baseUrl)
      .post(
        `/api/v1/admin/federation/peers/${encodeURIComponent(FED_DOMAIN_A)}/recognize`,
      )
      .set('Cookie', await getAdminCookie(appB));
    expect(recognition.status).toBe(200);

    const review = await waitFor(async () => {
      const row = await appA.database.query.federationIdentityReview.findFirst({
        where: eq(federationIdentityReview.nextDomain, NEW_DOMAIN),
        orderBy: (table, { desc }) => desc(table.id),
      });
      return row?.status === 'pending' ? row : undefined;
    }, 30_000);
    reviewId = review.id;
    expect(review).toMatchObject({
      kind: 'domain-rebind',
      claimedRoot: oldRoot,
    });
    const quarantined = await peer(FED_DOMAIN_B);
    expect(quarantined).toMatchObject({
      id: oldNamespaceId,
      rootPublicKey: oldRoot,
      peerAcceptanceConfirmed: false,
    });
    expect(quarantined!.trustLevel).not.toBe('available');
  }, 60_000);

  it('restores the same identity only after approval', async () => {
    const approved = await request(appA.baseUrl)
      .post(`/api/v1/admin/federation/identity-reviews/${reviewId}/approve`)
      .set('Cookie', adminCookieA);
    expect(approved.body.code).toBe(0);

    const recognized = await request(appB.baseUrl)
      .post(
        `/api/v1/admin/federation/peers/${encodeURIComponent(FED_DOMAIN_A)}/recognize`,
      )
      .set('Cookie', await getAdminCookie(appB));
    expect(recognized.status).toBe(200);

    const rebound = await waitFor(async () => {
      const row = await peer(NEW_DOMAIN);
      return row?.trustLevel === 'available' ? row : undefined;
    }, 30_000);
    expect(rebound).toMatchObject({
      id: oldNamespaceId,
      rootPublicKey: oldRoot,
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
    });
    expect(await peer(FED_DOMAIN_B)).toBeUndefined();
    await resolve(NEW_DOMAIN);
  }, 60_000);
});
