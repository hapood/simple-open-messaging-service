import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { identityNamespace } from '../src/database/schema.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  registerAndLogin,
  resolveFederatedCard,
} from './federation-test-helpers.js';

describe('Health recognition acknowledgement', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceToken: string;

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    ({ token: aliceToken } = await registerAndLogin(
      appA,
      'health-alice',
      'Health Alice',
    ));
    await registerAndLogin(appB, 'health-bob', 'Health Bob');
  }, 120_000);

  afterAll(async () => {
    proxy?.blockRecognize(false);
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('establishes acceptance on both peers with one successful Recognize', async () => {
    const result = await resolveFederatedCard(
      appA,
      aliceToken,
      'health-bob',
      FED_DOMAIN_B,
    );

    expect(result.event).toBe('resolved');
    const peerOnA = await appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_B),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peerOnA).toMatchObject({
      peerAcceptanceConfirmed: true,
      trustLevel: 'available',
      remoteServiceReachable: true,
    });

    const peerOnB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_A),
        eq(identityNamespace.active, true),
      ),
    });
    expect(peerOnB).toMatchObject({
      peerAcceptanceConfirmed: true,
      trustLevel: 'available',
    });
  });
});
