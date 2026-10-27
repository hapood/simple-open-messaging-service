import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { adminSession, identityNamespace } from '../src/database/schema.js';
import {
  bootFederationPair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session.js';
import { registerAndLogin } from './federation-test-helpers.js';

/**
 * End-to-end coverage of TLS-certificate replacement on an already-handshaked federation
 * peer. Production S2S transport is always https; the ordinary loopback harness bypasses
 * TLS with http routes. This spec instead runs BOTH apps as real TLS listeners:
 *
 *   - a per-run test CA signs each app's leaf certificate (SAN DNS:<peer-domain> for the
 *     production-shaped SNI/hostname verification, plus IP:127.0.0.1 for the test-process
 *     clients that dial the loopback listener directly);
 *   - each subprocess trusts the CA through NODE_EXTRA_CA_CERTS, so undici verifies the
 *     peer's certificate chain with default hostname checking;
 *   - the S2S identity keys are the deterministic in-memory keypair — this spec isolates
 *     the TRANSPORT layer: a TLS replacement must not disturb recognition at all.
 *
 *   1. alice@aaa.test resolves bob@bbb.test over TLS — handshake completes.
 *   2. appB's certificate is replaced (re-issued from the same CA, fresh key) and the
 *      process restarted: federation continues transparently in both directions.
 *   3. appB is re-issued a certificate from a DIFFERENT (untrusted) CA: transport fails,
 *      the peer degrades — but pins, acceptance evidence, and cached certificates are all
 *      retained, and the reverse direction (appB→appA) is unaffected.
 */

const tmp = mkdtempSync(join(tmpdir(), 'socs-fed-tls-'));
const caPem = join(tmp, 'ca.pem');
/** PEM CONTENTS for https.request's `ca` option — the option takes material, not a path
 *  (unlike NODE_EXTRA_CA_CERTS, which correctly receives the path for the subprocesses).
 *  Populated in beforeAll, after the CA exists. */
let caMaterial = '';

function openssl(args: string[]): void {
  execFileSync('openssl', args, { cwd: tmp, stdio: 'ignore' });
}

function makeCa(name: string): { cert: string; key: string } {
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.pem`,
    '-days',
    '2',
    '-subj',
    `/CN=${name}`,
  ]);
  return { cert: join(tmp, `${name}.pem`), key: join(tmp, `${name}.key`) };
}

/** Issue a leaf certificate for the loopback endpoint under the given CA. The DNS SAN carries the
 *  peer domain (the production-shaped dispatcher verifies hostname + SNI against the domain); the
 *  IP SAN lets the TEST-PROCESS clients, which dial 127.0.0.1 directly, verify the same leaf. */
function issueLeaf(
  name: string,
  ca: { cert: string; key: string },
  domain: string,
): void {
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    `/CN=${domain}`,
  ]);
  writeFileSync(
    join(tmp, `${name}.ext`),
    `subjectAltName=DNS:${domain},IP:127.0.0.1\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    ca.cert,
    '-CAkey',
    ca.key,
    '-CAcreateserial',
    '-out',
    `${name}.pem`,
    '-days',
    '2',
    '-extfile',
    `${name}.ext`,
  ]);
}

/** Serve appB's listener from these fixed paths — rotation overwrites them in place. */
const bCertPath = join(tmp, 'b-cert.pem');
const bKeyPath = join(tmp, 'b-key.pem');

function tlsRequest(
  port: number,
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: string;
    /** Skip the TEST-PROCESS client's verification — only for reaching the test probe on a
     *  listener that deliberately serves an untrusted certificate. The S2S leg inside the
     *  subprocess keeps full verification; that is the property under test. */
    insecure?: boolean;
  } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        ca: options.insecure ? undefined : caMaterial, // full verification against the per-run test CA
        rejectUnauthorized: !options.insecure,
        headers: options.headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.setTimeout(60_000, () =>
      req.destroy(new Error('TLS request timed out')),
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** The SSE card resolution over TLS — the resolveFederatedCard flow with an explicit CA. */
async function resolveCardTls(
  app: FedApp,
  token: string,
  account: string,
  domain: string,
): Promise<{ event: 'resolved' | 'failed'; data: Record<string, unknown> }> {
  const response = await tlsRequest(
    app.port,
    'GET',
    `/api/v1/user/resolve-federated-stream?account=${encodeURIComponent(account)}&domain=${encodeURIComponent(domain)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
    },
  );
  const terminalFrame = response.text
    .split(/\r?\n\r?\n/)
    .map((frame) => ({
      event: /^event:\s*(resolved|failed)$/m.exec(frame)?.[1] as
        | 'resolved'
        | 'failed'
        | undefined,
      raw: /^data:\s*(.+)$/m.exec(frame)?.[1],
    }))
    .find((frame) => frame.event !== undefined);
  if (response.status !== 200 || !terminalFrame?.event || !terminalFrame.raw)
    throw new Error(`invalid federated resolve stream: ${response.text}`);
  return {
    event: terminalFrame.event,
    data: JSON.parse(terminalFrame.raw) as Record<string, unknown>,
  };
}

async function seedAdminCookie(app: FedApp): Promise<string> {
  const adminRow = await app.database.query.admin.findFirst({
    columns: { id: true },
  });
  if (!adminRow) throw new Error('bootstrap admin is unavailable');
  const token = randomBytes(32).toString('base64url');
  await app.database.insert(adminSession).values({
    adminId: adminRow.id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `${ADMIN_SESSION_COOKIE}=${token}`;
}

async function resolveResolved(app: FedApp, token: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const card = await resolveCardTls(app, token, 'tls-bob', FED_DOMAIN_B);
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

function peerRowOnA() {
  return appA.database.query.identityNamespace.findFirst({
    where: and(
      eq(identityNamespace.domain, FED_DOMAIN_B),
      eq(identityNamespace.active, true),
    ),
  });
}

let appA: FedApp;
let appB: FedApp;
let proxy: S2sProxy;
let aliceToken: string;
let adminCookieB: string;

describe('federation survives a TLS certificate replacement', () => {
  beforeAll(async () => {
    const trustedCa = makeCa('ca');
    copyFileSync(trustedCa.cert, caPem);
    caMaterial = readFileSync(caPem, 'utf8');
    // appA's certificate is issued once; appB's is replaced by the rotation tests.
    issueLeaf('a', trustedCa, 'aaa.test');
    issueLeaf('b1', trustedCa, 'bbb.test');
    copyFileSync(join(tmp, 'b1.pem'), bCertPath);
    copyFileSync(join(tmp, 'b1.key'), bKeyPath);

    ({ appA, appB, proxy } = await bootFederationPair({
      scheme: 'https',
      appATls: { cert: join(tmp, 'a.pem'), key: join(tmp, 'a.key') },
      appBTls: { cert: bCertPath, key: bKeyPath },
      env: { NODE_EXTRA_CA_CERTS: caPem },
    }));
    ({ token: aliceToken } = await registerAndLogin(
      appA,
      'tls-alice',
      'TLS Alice',
    ));
    await registerAndLogin(appB, 'tls-bob', 'TLS Bob');
    adminCookieB = await seedAdminCookie(appB);

    // 1. The handshake completes over verified TLS.
    await resolveResolved(appA, aliceToken);
    expect(await peerRowOnA()).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
    });
  }, 180_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('continues federation transparently across a certificate replacement', async () => {
    // Re-issue appB's certificate from the SAME CA with a fresh key and restart it —
    // a routine renewal. Recognition must not be disturbed in either direction.
    issueLeaf('b2', { cert: caPem, key: join(tmp, 'ca.key') }, 'bbb.test');
    copyFileSync(join(tmp, 'b2.pem'), bCertPath);
    copyFileSync(join(tmp, 'b2.key'), bKeyPath);
    await appB.restart();

    // appA → appB over the new certificate (card resolution re-fetches the profile).
    await resolveResolved(appA, aliceToken);

    const namespaceOnB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_A),
        eq(identityNamespace.active, true),
      ),
      columns: { id: true },
    });
    expect(namespaceOnB).toBeDefined();

    // appB → appA still works after appB's restart (its own outbound TLS to appA,
    // plus a fully signed + verified S2S round trip through the admin health surface).
    const probe = await tlsRequest(
      appB.port,
      'POST',
      '/api/v1/admin/federation/health/probe',
      {
        headers: {
          cookie: adminCookieB,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ namespaceId: namespaceOnB!.id }),
      },
    );
    expect(probe.status).toBe(200);
    const relayed = JSON.parse(probe.text) as {
      data: { feedProgress: { latestHealthCheck: { status: string } } };
    };
    expect(relayed.data.feedProgress.latestHealthCheck.status).toBe('available');

    // The S2S identity is untouched by the transport change.
    expect(await peerRowOnA()).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
    });
  }, 120_000);

  it('rejects an untrusted replacement certificate and degrades without losing the pin', async () => {
    const rowBefore = await peerRowOnA();
    expect(rowBefore?.rootPublicKey).toBeTruthy();

    // A certificate from a DIFFERENT CA with the same SAN: hostname matches, but the
    // chain does not anchor at anything appA trusts. Verification must fail closed.
    const untrustedCa = makeCa('ca2');
    issueLeaf('bad', untrustedCa, 'bbb.test');
    copyFileSync(join(tmp, 'bad.pem'), bCertPath);
    copyFileSync(join(tmp, 'bad.key'), bKeyPath);
    await appB.restart();

    const card = await resolveCardTls(
      appA,
      aliceToken,
      'tls-bob',
      FED_DOMAIN_B,
    );
    expect(card.event).toBe('failed');
    expect(['UNREACHABLE', 'TIMEOUT']).toContain(card.data.reason);

    // Transport failure degrades reachability but never drops recognition facts: pin,
    // acceptance evidence, and cached certificates are all retained.
    const degraded = await peerRowOnA();
    expect(degraded).toMatchObject({
      id: rowBefore!.id,
      rootPublicKey: rowBefore!.rootPublicKey,
      trustLevel: 'degraded',
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: false,
    });

    const namespaceOnB = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, FED_DOMAIN_A),
        eq(identityNamespace.active, true),
      ),
      columns: { id: true },
    });
    expect(namespaceOnB).toBeDefined();

    // The reverse leg (appB → appA) is unaffected by appB's own listener certificate.
    // The probe call itself must skip the test client's verification: appB deliberately
    // serves the untrusted certificate now (the B→A S2S leg inside appB stays strict).
    const probe = await tlsRequest(
      appB.port,
      'POST',
      '/api/v1/admin/federation/health/probe',
      {
        insecure: true,
        headers: {
          cookie: adminCookieB,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ namespaceId: namespaceOnB!.id }),
      },
    );
    expect(probe.status, probe.text).toBe(200);
    expect(
      (JSON.parse(probe.text) as { data: { feedProgress: { latestHealthCheck: { status: string } } } }).data.feedProgress.latestHealthCheck.status,
    ).toBe('degraded');
  }, 120_000);
});
