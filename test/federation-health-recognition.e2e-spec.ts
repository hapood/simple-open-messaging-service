import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { federatedPeer } from '../src/database/schema.js';
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

  it('resolves through positive Health while reverse Recognize is blocked', async () => {
    proxy.blockRecognize(true);

    const result = await resolveFederatedCard(
      appA,
      aliceToken,
      'health-bob',
      FED_DOMAIN_B,
    );

    expect(result.event).toBe('resolved');
    await vi.waitFor(() => {
      expect(proxy.blockedRecognizeCount()).toBeGreaterThan(0);
    });

    const peerOnA = await appA.database.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, FED_DOMAIN_B),
    });
    expect(peerOnA).toMatchObject({
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      lightweightInboundReady: true,
      remoteServiceReachable: true,
    });

    const peerOnBWhileBlocked =
      await appB.database.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, FED_DOMAIN_A),
      });
    expect(peerOnBWhileBlocked).toMatchObject({
      inboundRecognitionConfirmed: true,
      outboundRecognitionConfirmed: false,
    });

    proxy.blockRecognize(false);
    await vi.waitFor(
      async () => {
        const peerOnB = await appB.database.query.federatedPeer.findFirst({
          where: eq(federatedPeer.domain, FED_DOMAIN_A),
        });
        expect(peerOnB?.outboundRecognitionConfirmed).toBe(true);
      },
      { timeout: 15_000 },
    );
  });
});
