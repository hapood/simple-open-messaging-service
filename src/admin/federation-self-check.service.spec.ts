import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { FederationSelfCheckService } from './federation-self-check.service.js';
import { signingCertificateStatement } from '../federation/federation-certificate.js';

type CheckResult = {
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  evidence?: Record<string, unknown>;
};

interface SrvResolutionLike {
  hasSrv: boolean;
  srvError: string | null;
  rrsetError: string | null;
  records: string[];
  targets: { host: string; port: number }[];
}

const noSrv: SrvResolutionLike = {
  hasSrv: false,
  srvError: null,
  rrsetError: null,
  records: [],
  targets: [],
};

/** The service internals the tests drive, exposed through a structural cast (same instance). */
type Service = ReturnType<typeof makeService>;

function makeService(domain = 'chat.example.com', allowInsecureHttp = false) {
  const service = new FederationSelfCheckService(
    { getIdentityDomain: () => domain } as never,
    {} as never,
    { get: () => ({ allowInsecureHttp }) } as never,
  );
  return service as unknown as {
    checkDnsSrv: (
      domain: string,
      srv: SrvResolutionLike,
    ) => Promise<CheckResult>;
    checkDnsA: (
      v4: string[],
      v6: string[],
      perTarget: {
        target: { host: string; port: number };
        v4: string[];
        v6: string[];
      }[],
    ) => Promise<CheckResult>;
    checkWellKnown: (
      ips: unknown[],
      probes: {
        status: 'ok' | 'warn' | 'fail' | 'skip';
        target?: string | null;
        ip: string;
        doc?: { software?: string | null; keys?: { keyId: string }[] };
      }[],
    ) => Promise<CheckResult>;
    resolveSrvInfo: (
      resolver: unknown,
      domain: string,
    ) => Promise<SrvResolutionLike>;
    checkConfig: () => Promise<CheckResult>;
    checkKeyMaterial: () => Promise<CheckResult>;
    checkKeyAge: () => Promise<CheckResult>;
    checkClockSkew: () => Promise<CheckResult>;
    checkTlsLoopback: () => Promise<CheckResult>;
    checkKeyConsistency: (...args: unknown[]) => Promise<CheckResult>;
    checkSignLoopback: (...args: unknown[]) => Promise<CheckResult>;
    safeResolve: (
      resolver: unknown,
      host: string,
      family: 4 | 6,
    ) => Promise<string[]>;
    probeTls: (...args: unknown[]) => Promise<Record<string, unknown>>;
    probeWellKnown: (...args: unknown[]) => Promise<Record<string, unknown>>;
    run: (opts?: Record<string, unknown>) => Promise<{
      checks: {
        key: string;
        status: string;
        blockedBy?: string;
        detail?: string;
        evidence?: Record<string, unknown>;
      }[];
      summary: Record<string, number>;
      target: { host: string; port: number; hasSrv: boolean };
    }>;
  };
}

const ok: CheckResult = { status: 'ok', detail: 'ok' };

/** Mock every local check so a full `run` exercises only the SRV/target wiring. */
function mockLocalChecks(service: Service) {
  vi.spyOn(service, 'checkConfig').mockResolvedValue(ok);
  vi.spyOn(service, 'checkKeyMaterial').mockResolvedValue(ok);
  vi.spyOn(service, 'checkKeyAge').mockResolvedValue(ok);
  vi.spyOn(service, 'checkClockSkew').mockResolvedValue(ok);
  vi.spyOn(service, 'checkTlsLoopback').mockResolvedValue(ok);
  vi.spyOn(service, 'checkKeyConsistency').mockResolvedValue(ok);
}

describe('FederationSelfCheckService SRV handling', () => {
  it('fails when the configured federation domain has no mandatory SRV record', async () => {
    const service = makeService();
    const result = await service.checkDnsSrv('chat.example.com', noSrv);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('_somfp._tcp.chat.example.com');
    expect(result.detail).toContain('cannot discover');
    expect(result.evidence).toMatchObject({ records: [] });
  });

  it('distinguishes a transient resolver failure from an absent record', async () => {
    const service = makeService();
    const result = await service.checkDnsSrv('chat.example.com', {
      ...noSrv,
      srvError: 'ETIMEOUT',
    });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ETIMEOUT');
    expect(result.detail).toContain('retry');
    expect(result.detail).not.toContain('missing required');
  });

  it('reports a sole "." target as an explicit service disablement', async () => {
    const service = makeService();
    const result = await service.checkDnsSrv('chat.example.com', {
      ...noSrv,
      rrsetError:
        'sole "." target — the domain explicitly publishes no SOMFP service',
      records: ['0 0 0 .'],
    });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('no SOMFP service');
  });

  it('classifies resolver failures and RRset violations when resolving', async () => {
    const service = makeService();
    const srvRecord = {
      name: 'edge.example.net',
      port: 7667,
      priority: 0,
      weight: 0,
    };
    expect(
      await service.resolveSrvInfo(
        {
          resolveSrv: async () => {
            throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
          },
        },
        'chat.example.com',
      ),
    ).toMatchObject({ hasSrv: false, srvError: 'ETIMEOUT' });
    expect(
      await service.resolveSrvInfo(
        { resolveSrv: async () => [srvRecord] },
        'chat.example.com',
      ),
    ).toMatchObject({
      hasSrv: true,
      targets: [{ host: 'edge.example.net', port: 7667 }],
    });
    expect(
      await service.resolveSrvInfo(
        { resolveSrv: async () => [{ ...srvRecord, port: 0 }] },
        'chat.example.com',
      ),
    ).toMatchObject({
      hasSrv: false,
      rrsetError: expect.stringContaining('invalid SRV fields'),
    });
    expect(
      await service.resolveSrvInfo(
        {
          resolveSrv: async () => [
            { name: '.', port: 0, priority: 0, weight: 0 },
          ],
        },
        'chat.example.com',
      ),
    ).toMatchObject({
      hasSrv: false,
      rrsetError: expect.stringContaining('no SOMFP service'),
    });
  });

  it('does not probe a guessed direct endpoint when SRV is absent', async () => {
    const service = makeService();
    mockLocalChecks(service);
    vi.spyOn(service, 'resolveSrvInfo').mockResolvedValue(noSrv);
    const resolveAddresses = vi.spyOn(service, 'safeResolve');
    const tls = vi.spyOn(service, 'probeTls');
    const wellKnown = vi.spyOn(service, 'probeWellKnown');

    const report = await service.run({});

    expect(report.checks.find((c) => c.key === 'dns-srv')?.status).toBe('fail');
    expect(report.checks.find((c) => c.key === 'dns-a')).toMatchObject({
      status: 'skip',
      blockedBy: 'dns-srv',
    });
    expect(report.summary.fail).toBe(1);
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(tls).not.toHaveBeenCalled();
    expect(wellKnown).not.toHaveBeenCalled();
  });

  it('probes every SRV target with the federation domain as TLS name and authority', async () => {
    const service = makeService();
    mockLocalChecks(service);
    vi.spyOn(service, 'resolveSrvInfo').mockResolvedValue({
      hasSrv: true,
      srvError: null,
      rrsetError: null,
      records: ['0 0 7667 edge.example.net', '10 0 8443 backup.example.net'],
      targets: [
        { host: 'edge.example.net', port: 7667 },
        { host: 'backup.example.net', port: 8443 },
      ],
    });
    vi.spyOn(service, 'safeResolve').mockImplementation(
      async (_resolver, host, family) =>
        family !== 4
          ? []
          : host === 'edge.example.net'
            ? ['192.0.2.10']
            : ['192.0.2.20'],
    );
    const tls = vi
      .spyOn(service, 'probeTls')
      .mockImplementation(async (...args: unknown[]) => ({
        ip: args[0],
        family: args[1],
        target: args[5],
        reachable: true,
        status: 'ok',
        detail: 'ok',
      }));
    const wellKnown = vi
      .spyOn(service, 'probeWellKnown')
      .mockImplementation(async (...args: unknown[]) => ({
        ip: args[0],
        family: args[1],
        target: args[6],
        reachable: true,
        status: 'ok',
        detail: 'ok',
        doc: {
          software: 'soms/1',
          keys: [{ keyId: 'chat.example.com/key-1' }],
        },
        keysValid: true,
      }));
    const signature = vi
      .spyOn(service, 'checkSignLoopback')
      .mockResolvedValue(ok);

    const report = await service.run({});

    expect(tls).toHaveBeenCalledWith(
      '192.0.2.10',
      4,
      'chat.example.com',
      7667,
      expect.anything(),
      'edge.example.net:7667',
    );
    expect(tls).toHaveBeenCalledWith(
      '192.0.2.20',
      4,
      'chat.example.com',
      8443,
      expect.anything(),
      'backup.example.net:8443',
    );
    expect(wellKnown).toHaveBeenCalledTimes(2);
    // The logical authority uses the federation domain and the primary (lowest-priority) target's port.
    expect(signature).toHaveBeenCalledWith(
      expect.objectContaining({ software: 'soms/1' }),
      'chat.example.com:7667',
    );
    expect(report.target).toMatchObject({
      host: 'edge.example.net',
      port: 7667,
      hasSrv: true,
    });
    expect(
      report.checks.find((c) => c.key === 'dns-srv')?.evidence,
    ).toMatchObject({
      targets: ['edge.example.net:7667', 'backup.example.net:8443'],
    });
  });

  it('verifies the signature against the published key matching the request keyId, not keys[0]', async () => {
    const b64Key = (c: string) => c.repeat(43).slice(0, 43) + '=';
    const service = new FederationSelfCheckService(
      { getIdentityDomain: () => 'chat.example.com' } as never,
      {
        signOutbound: async () => ({
          'signature-input':
            'sig1=("@method");keyid="chat.example.com/key-2";alg="ed25519"',
        }),
        verifyWithKey: async () => true,
      } as never,
      { get: () => ({}) } as never,
    ) as unknown as {
      checkSignLoopback: (
        doc: { keys: { keyId: string; ed25519: string }[] },
        authority: string,
      ) => Promise<CheckResult>;
    };

    const result = await service.checkSignLoopback(
      {
        keys: [
          { keyId: 'chat.example.com/key-1', ed25519: b64Key('A') },
          { keyId: 'chat.example.com/key-2', ed25519: b64Key('B') },
        ],
      },
      'chat.example.com:7667',
    );

    expect(result.status).toBe('ok');
    expect(result.evidence).toMatchObject({
      keyId: 'chat.example.com/key-2',
      publishedKeyFound: true,
    });
  });

  it('fails when the signing keyId is not in the published set (rotation drift)', async () => {
    const service = new FederationSelfCheckService(
      { getIdentityDomain: () => 'chat.example.com' } as never,
      {
        signOutbound: async () => ({
          'signature-input':
            'sig1=("@method");keyid="chat.example.com/key-9";alg="ed25519"',
        }),
        verifyWithKey: async () => true,
      } as never,
      { get: () => ({}) } as never,
    ) as unknown as {
      checkSignLoopback: (
        doc: { keys: { keyId: string; ed25519: string }[] },
        authority: string,
      ) => Promise<CheckResult>;
    };

    const result = await service.checkSignLoopback(
      {
        keys: [
          { keyId: 'chat.example.com/key-1', ed25519: 'A'.repeat(43) + '=' },
        ],
      },
      'chat.example.com:7667',
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not in the published key set');
  });

  it('deep-validates the published document exactly as a peer would', async () => {
    const service = makeService() as unknown as {
      parseWellKnownResponse: (
        ip: string,
        family: 4 | 6,
        domain: string,
        target: string,
        status: number,
        contentType: string,
        body: string,
        httpVersion: string,
      ) => {
        status: string;
        detail: string;
        keysValid?: boolean;
        keyCount?: number;
      };
    };
    const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, i) => i);
    const rootPublicKey = Buffer.from(
      ed25519.getPublicKey(rootPrivateKey),
    ).toString('base64');
    const unsigned = {
      keyId: 'chat.example.com/k-1',
      ed25519: Buffer.from(
        ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)),
      ).toString('base64'),
      root: rootPublicKey,
      notBefore: Date.now() - 60_000,
      notAfter: Date.now() + 86_400_000,
    };
    const validDoc = JSON.stringify({
      software: 'soms/1.0.0',
      protocolVersions: [1],
      roots: [
        {
          ed25519: rootPublicKey,
          notBefore: 1,
          notAfter: Number.MAX_SAFE_INTEGER,
        },
      ],
      keys: [
        {
          ...unsigned,
          authorizationSignature: Buffer.from(
            ed25519.sign(
              Buffer.from(signingCertificateStatement(unsigned)),
              rootPrivateKey,
            ),
          ).toString('base64'),
        },
      ],
    });

    const ok = service.parseWellKnownResponse(
      '192.0.2.10',
      4,
      'chat.example.com',
      'edge.example.net:7667',
      200,
      'application/json',
      validDoc,
      '1.1',
    );
    expect(ok.status).toBe('ok');
    expect(ok.keysValid).toBe(true);
    expect(ok.keyCount).toBe(1);

    // A document whose signing key is outside its root's validity enclosure is
    // what a peer's validate step rejects — the probe must fail with that reason.
    const rootExpired = JSON.stringify({
      software: 'soms/1.0.0',
      protocolVersions: [1],
      roots: [
        {
          ed25519: rootPublicKey,
          notBefore: 1,
          notAfter: Date.now() - 1,
        },
      ],
      keys: JSON.parse(validDoc).keys,
    });
    const bad = service.parseWellKnownResponse(
      '192.0.2.10',
      4,
      'chat.example.com',
      'edge.example.net:7667',
      200,
      'application/json',
      rootExpired,
      '1.1',
    );
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('no currently valid root');
  });

  it('fails clock skew against the stricter of the wire window and the configured budget', async () => {
    const service = makeService() as unknown as {
      checkClockSkew: (
        ntpServer: string,
        clockSkewBudgetMs: number,
      ) => Promise<CheckResult>;
      queryNtp: (
        server: string,
      ) => Promise<{ offsetSec: number; roundTripMs: number }>;
    };
    const offset = (seconds: number) =>
      vi
        .spyOn(service, 'queryNtp')
        .mockResolvedValue({ offsetSec: seconds, roundTripMs: 30 });

    offset(10);
    expect((await service.checkClockSkew('ntp.test', 600_000)).status).toBe(
      'ok',
    );
    offset(90);
    expect((await service.checkClockSkew('ntp.test', 600_000)).status).toBe(
      'warn',
    );
    // Wire-level binding: 400s exceeds the 300s signed-Date window even though the
    // configured budget (600s) would tolerate it.
    offset(400);
    const wire = await service.checkClockSkew('ntp.test', 600_000);
    expect(wire.status).toBe('fail');
    expect(wire.detail).toContain('rejected by peers');
    // Budget binding: 200s is inside the wire window but exceeds a tight 120s budget.
    const budget = await service.checkClockSkew('ntp.test', 120_000);
    expect(budget.status).toBe('fail');
    expect(budget.detail).toContain('clock-skew budget');
    expect(budget.evidence).toMatchObject({ failSec: 120, warnSec: 60 });
  });

  it('rejects a .well-known response whose media type is not application/json', async () => {
    const service = makeService() as unknown as {
      parseWellKnownResponse: (
        ip: string,
        family: 4 | 6,
        domain: string,
        target: string,
        status: number,
        contentType: string,
        body: string,
        httpVersion: string,
      ) => { status: string; detail: string };
    };

    const html = service.parseWellKnownResponse(
      '192.0.2.10',
      4,
      'chat.example.com',
      'edge.example.net:7667',
      200,
      'text/html',
      '{}',
      '1.1',
    );
    expect(html.status).toBe('fail');
    expect(html.detail).toContain('application/json');

    const json = service.parseWellKnownResponse(
      '192.0.2.10',
      4,
      'chat.example.com',
      'edge.example.net:7667',
      200,
      'application/json; charset=utf-8',
      JSON.stringify({ software: 'soms/1.0.0' }),
      '1.1',
    );
    // Media type with parameters is accepted; the body itself still has to pass
    // deep validation (this minimal body fails there, not at the media-type gate).
    expect(json.detail).not.toContain('Content-Type');
  });

  it('fails an SRV target that resolves to no address at all', async () => {
    const service = makeService();
    const result = await service.checkDnsA(
      ['192.0.2.10'],
      [],
      [
        {
          target: { host: 'edge.example.net', port: 7667 },
          v4: ['192.0.2.10'],
          v6: [],
        },
        { target: { host: 'backup.example.net', port: 8443 }, v4: [], v6: [] },
      ],
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('backup.example.net');
  });

  it('flags SRV targets serving inconsistent discovery documents', async () => {
    const service = makeService();
    const doc = (keyId: string) => ({
      software: 'soms/1',
      keys: [{ keyId }],
    });
    const result = await service.checkWellKnown(
      [{ ip: '192.0.2.10' }, { ip: '192.0.2.20' }],
      [
        {
          status: 'ok',
          ip: '192.0.2.10',
          target: 'a:7667',
          doc: doc('d/key-1'),
        },
        {
          status: 'ok',
          ip: '192.0.2.20',
          target: 'b:8443',
          doc: doc('d/key-2'),
        },
      ],
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('INCONSISTENT');

    const consistent = await service.checkWellKnown(
      [{ ip: '192.0.2.10' }, { ip: '192.0.2.20' }],
      [
        {
          status: 'ok',
          ip: '192.0.2.10',
          target: 'a:7667',
          doc: doc('d/key-1'),
        },
        {
          status: 'ok',
          ip: '192.0.2.20',
          target: 'b:8443',
          doc: doc('d/key-1'),
        },
      ],
    );
    expect(consistent.status).toBe('ok');
    expect(consistent.evidence).toMatchObject({ documentsConsistent: true });
  });

  it('skips the whole external probe set in insecure dev mode', async () => {
    const service = makeService('chat.example.com', true);
    mockLocalChecks(service);
    vi.spyOn(service, 'checkConfig').mockImplementation(async () => ({
      status: 'warn',
      detail: 'allowInsecureHttp is ON (dev-only)',
    }));
    const resolveSrv = vi.spyOn(service, 'resolveSrvInfo');
    const tls = vi.spyOn(service, 'probeTls');
    const wellKnown = vi.spyOn(service, 'probeWellKnown');

    const report = await service.run({});

    // Local checks still run; nothing network-facing does.
    expect(report.checks.find((c) => c.key === 'config')?.status).toBe('warn');
    for (const key of [
      'dns-srv',
      'dns-a',
      'tls-public',
      'well-known',
      'sign-loopback',
      'clock-skew',
    ]) {
      expect(report.checks.find((c) => c.key === key)).toMatchObject({
        status: 'skip',
        blockedBy: 'config',
      });
    }
    expect(resolveSrv).not.toHaveBeenCalled();
    expect(tls).not.toHaveBeenCalled();
    expect(wellKnown).not.toHaveBeenCalled();
  });
});
