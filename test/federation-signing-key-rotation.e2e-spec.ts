import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { identityNamespace } from '../src/database/schema.js';
import { verifySigningCertificate } from '../src/federation/federation-certificate.js';
import { parseKeyId } from '../src/federation/key-id.js';
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

/**
 * End-to-end coverage of the database-backed signing-key rotation lifecycle: both apps run
 * the REAL KeypairService (not the deterministic in-memory fake) with compressed lifetimes,
 * so one test run observes successor prepublication, the planned switch, overlap acceptance
 * by the receiving peer, and predecessor removal.
 *
 * Compressed timeline (validated by config guards: lifetime > prepub + retention + skew):
 *   t0            bootstrap: key1 valid [t0, t0+30s)
 *   t0+14s        successor key2 planned + published (notAfter - prepub - retention)
 *   t0+22s        planned switch (max(notAfter - retention, plan-time + skew))
 *   t0+30s        key1 reaches its advertised notAfter: unpublished, row removed
 * Setup (boot + register + first resolution) completes well inside the t0+14s window, so the
 * first resolution always signs with key1; later phases are observed by polling.
 */
const LIFETIME_MS = '30000';
const PREPUBLICATION_MS = '8000';
const RETENTION_MS = '8000';
const SKEW_MS = '2000';

interface WellKnownKey {
  keyId: string;
  ed25519: string;
  notBefore: number;
  notAfter: number;
  authorizationSignature: string;
}

interface WellKnownDocument {
  protocolVersions: number[];
  roots: Array<{ ed25519: string; notBefore: number; notAfter: number }>;
  keys: WellKnownKey[];
}

describe('database-backed signing-key rotation', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let aliceToken: string;
  let firstKeyId: string;
  let firstKeyNotAfter: number;

  /** Resolve alice→bob, retrying transient failures: inbound Recognize verification is
   *  asynchronous at HEAD (first response is `pending`), so the caller re-resolves until
   *  the peer's cached verification result surfaces. */
  async function resolveResolved(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const card = await resolveFederatedCard(
        appA,
        aliceToken,
        'rotation-bob',
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

  async function currentState(): Promise<{
    currentKeyId: string;
    plannedSuccessorKeyId: string | null;
    keyRows: Array<{ keyId: string; notAfter: Date }>;
  }> {
    const [state, rows] = await Promise.all([
      appA.database.query.localFederationSigningState.findFirst(),
      appA.database.query.localFederationSigningKey.findMany(),
    ]);
    return {
      currentKeyId: state!.currentKeyId,
      plannedSuccessorKeyId: state!.plannedSuccessorKeyId ?? null,
      keyRows: rows.map((row) => ({
        keyId: row.keyId,
        notAfter: row.notAfter,
      })),
    };
  }

  async function wellKnown(): Promise<WellKnownDocument> {
    const response = await fetch(
      `http://127.0.0.1:${appA.port}/.well-known/somfp`,
      { headers: { Accept: 'application/json' } },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as WellKnownDocument;
  }

  /** Poll until the predicate holds on the observed well-known key set, with a bounded wait. */
  async function pollWellKnown(
    timeoutMs: number,
    predicate: (keys: WellKnownKey[]) => boolean,
  ): Promise<WellKnownKey[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const keys = (await wellKnown()).keys;
      if (predicate(keys)) return keys;
      if (Date.now() > deadline)
        throw new Error(
          `well-known key set did not reach the expected state within ${timeoutMs}ms: ${keys.map((key) => key.keyId).join(', ')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair({
      env: {
        FED_E2E_REAL_KEYPAIR: '1',
        SOMS_FEDERATION_SIGNING_KEY_LIFETIME_MS: LIFETIME_MS,
        SOMS_FEDERATION_SUCCESSOR_PREPUBLICATION_MS: PREPUBLICATION_MS,
        SOMS_FEDERATION_PREDECESSOR_RETENTION_MS: RETENTION_MS,
        SOMS_FEDERATION_CLOCK_SKEW_BUDGET_MS: SKEW_MS,
        // Inbound Health is strictly cached-only (never triggers discovery), so the
        // receiver learns the rotated key only through the Health round's coverage-based
        // certificate refresh. Compress that cadence too, or the compressed switch
        // window outruns it.
        SOMS_FEDERATION_KEY_REFRESH_POLL_MS: '2000',
      },
    }));
    // Capture the bootstrap signer before any rotation event (t0 + 14s at the earliest).
    const initial = await currentState();
    firstKeyId = initial.currentKeyId;
    const firstRow = initial.keyRows.find((row) => row.keyId === firstKeyId)!;
    firstKeyNotAfter = firstRow.notAfter.getTime();

    ({ token: aliceToken } = await registerAndLogin(
      appA,
      'rotation-alice',
      'Rotation Alice',
    ));
    await registerAndLogin(appB, 'rotation-bob', 'Rotation Bob');

    // Acceptance is established while key1 is still the sole signer.
    await resolveResolved();
  }, 180_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('bootstraps a database-backed identity with a grammar-valid certificate', async () => {
    const keys = (await wellKnown()).keys;
    expect(keys).toHaveLength(1);
    const certificate = keys[0]!;
    expect(certificate.keyId).toBe(firstKeyId);
    expect(parseKeyId(certificate.keyId)).toEqual({
      domain: FED_DOMAIN_A,
      keyName: expect.stringMatching(/^k-[A-Za-z0-9_-]{20}$/),
    });
  });

  it('prepublishes a root-authorized successor before switching', async () => {
    // Overlap: the successor appears while the predecessor still signs new requests.
    const keys = await pollWellKnown(
      20_000,
      (observed) => observed.length === 2,
    );
    const doc = await wellKnown();
    const claimableRoot = doc.roots.find(
      (root) => root.notBefore <= Date.now() && Date.now() < root.notAfter,
    )!;
    for (const certificate of keys) {
      expect(verifySigningCertificate(certificate, claimableRoot.ed25519)).toBe(
        true,
      );
    }
    const successor = keys.find((key) => key.keyId !== firstKeyId)!;
    expect(parseKeyId(successor.keyId)?.domain).toBe(FED_DOMAIN_A);

    const state = await currentState();
    expect(state.currentKeyId).toBe(firstKeyId);
    expect(state.plannedSuccessorKeyId).toBe(successor.keyId);
    // The receiver keeps accepting the predecessor's requests during the overlap.
    await resolveResolved();
  });

  it('switches the outbound signer without disturbing acceptance', async () => {
    const deadline = Date.now() + 20_000;
    let state = await currentState();
    while (state.currentKeyId === firstKeyId) {
      if (Date.now() > deadline)
        throw new Error('planned signing-key switch did not land in time');
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await currentState();
    }
    const successorKeyId = state.currentKeyId;
    expect(state.plannedSuccessorKeyId).toBeNull();

    // The predecessor remains published (and receiver-acceptable) until its notAfter.
    const keys = await pollWellKnown(5_000, (observed) =>
      observed.some((key) => key.keyId === successorKeyId),
    );
    expect(keys.some((key) => key.keyId === firstKeyId)).toBe(true);

    // A NEW signed request uses the successor; the peer accepts it — the successor
    // certificate was pulled by the Health round's coverage-based refresh — without
    // any Recognize restart or lifecycle disturbance.
    await resolveResolved();
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
  }, 30_000);

  it('removes the predecessor after its advertised notAfter', async () => {
    // key1 stops being published at its notAfter (already stored; ~t0+30s). With a
    // continuous rotation the published set never returns to one certificate: each
    // successor is prepublished before its predecessor expires, so the assertion
    // targets the predecessor itself, not the set size. Expired key rows are
    // retained by design (sealed-challenge history), so we assert the predecessor
    // is gone from the published set and that its row has expired, not that the
    // row was deleted.
    expect(Date.now()).toBeLessThan(firstKeyNotAfter + 30_000);
    const keys = await pollWellKnown(
      30_000,
      (observed) => !observed.some((key) => key.keyId === firstKeyId),
    );
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const state = await currentState();
    const predecessorRow = state.keyRows.find(
      (row) => row.keyId === firstKeyId,
    );
    expect(predecessorRow).toBeDefined();
    expect(predecessorRow!.notAfter.getTime()).toBeLessThanOrEqual(Date.now());
  }, 45_000);
});
