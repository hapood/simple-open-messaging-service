import {
  BadRequestException,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { addressScope } from './network-inspection.service.js';
import { resolveDnsEvidence, type ResolvedDnsView } from './dns-evidence.js';
import { normalizeFederationDomain } from '../well-known-document.js';
import type { SomfpSrvRrset } from '../srv-rrset.js';
import type {
  RootKeyEntry,
  SigningKeyCertificate,
} from '../federation-certificate.js';
import { FederationTransportConfigService } from '../federation-transport-config.service.js';
import {
  createFederationDispatcher,
  resolveFederationRoute,
  requestFederation,
  readFederationDiscovery,
  type TransportObservation,
  type FederationCertificateEvidence,
} from '../federation-transport.js';

export function parseDiagnosticTarget(input: string): string {
  try {
    const domain = normalizeFederationDomain(input);
    const hostname = new URL(`https://${domain}`).hostname;
    if (domain.length > 253 || isIP(hostname) || hostname !== domain)
      throw new Error();
    return domain;
  } catch {
    throw new BadRequestException(
      'Enter a federation domain without a scheme, port, path, or IP address; the endpoint is discovered through SRV',
    );
  }
}

type CheckBase = { status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string };
type DnsEvidence = {
  host: string;
  /** Addresses the shared connector actually dialed (OS resolver view). */
  dial: { address: string; family: number; scope: string }[];
  /** Raw DNS protocol view from the configured resolvers. */
  resolved: ResolvedDnsView;
};
type Check = CheckBase &
  (
    | { name: 'srv'; evidence?: SomfpSrvRrset }
    | { name: 'dns'; evidence?: DnsEvidence }
    | {
        name: 'https';
        evidence?: {
          address: string;
          port: number;
          certificate: FederationCertificateEvidence | null;
        };
      }
    | {
        name: 'federation';
        evidence?: {
          protocolVersions: number[];
          roots: RootKeyEntry[];
          keys: SigningKeyCertificate[];
        };
      }
  );

/** Never throws: an unparseable answer is itself diagnostic information. */
function safeAddressScope(address: string): string {
  try {
    return addressScope(address);
  } catch {
    return 'invalid';
  }
}

function pendingView(host: string): ResolvedDnsView {
  return { host, v4: [], v6: [], cnameChain: [], errors: {} };
}

/** Bounded so a stalled resolver can never extend the diagnostic beyond its report. */
async function mergeDnsEvidence(
  evidence: Promise<ResolvedDnsView> | undefined,
  check: Extract<Check, { name: 'dns' }> | undefined,
): Promise<void> {
  if (!evidence || !check?.evidence) return;
  const deadline = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), 5000).unref();
  });
  const view = await Promise.race([evidence.catch(() => undefined), deadline]);
  if (!view) return;
  check.evidence.resolved = view;
  if (view.cnameChain.length) {
    check.status = 'warn';
    const names = [
      check.evidence.host,
      ...view.cnameChain.map((hop) => hop.targets[0]),
    ];
    check.detail = `${check.detail}; CNAME chain ${names.join(' -> ')} (RFC 2782 advises against CNAME SRV targets)`;
  }
}

/** A fresh, isolated use of the real federation transport. No trust or business
 * state is changed. Resolver answers and their failures are reported verbatim. */
@Injectable()
export class TargetNetworkDiagnosticsService {
  private running = false;
  private lastFinishedAt = 0;

  constructor(
    private readonly transportConfig: FederationTransportConfigService,
  ) {}

  async run(input: string) {
    const domain = parseDiagnosticTarget(input);
    if (this.running || Date.now() - this.lastFinishedAt < 3000)
      throw new HttpException(
        'A diagnostic is running or cooling down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.running = true;
    const startedAt = Date.now();
    const checks: Check[] = [];
    const config = this.transportConfig.get();
    let route: {
      domain: string;
      host: string;
      port: number;
      origin: string;
    } | null = null;
    let dispatcher: ReturnType<typeof createFederationDispatcher> | undefined;
    let dnsCheck: Extract<Check, { name: 'dns' }> | undefined;
    let evidencePromise: Promise<ResolvedDnsView> | undefined;
    let phase: Check['name'] = 'srv';
    const observe = (event: TransportObservation) => {
      if (event.phase === 'srv') {
        checks.push({
          name: 'srv',
          status: event.evidence.kind === 'targets' ? 'ok' : 'fail',
          detail:
            event.evidence.kind === 'targets'
              ? 'Shared federation SRV priority/weight selection'
              : `SOMFP SRV: ${event.evidence.kind}; no fallback to port 443`,
          evidence: event.evidence,
        });
      } else if (event.phase === 'dns') {
        phase = 'dns';
        // Only a non-empty answer describes a dialable resolver verdict; an
        // empty answer leaves the phase on 'dns' so the connector's dial
        // failure keeps this phase's name.
        if (event.addresses.length) {
          dnsCheck = {
            name: 'dns',
            status: 'ok',
            detail: `${event.host} -> ${event.addresses
              .map((address) => `${address} (${safeAddressScope(address)})`)
              .join(', ')}`,
            evidence: {
              host: event.host,
              dial: event.addresses.map((address) => ({
                address,
                family: isIP(address),
                scope: safeAddressScope(address),
              })),
              resolved: pendingView(event.host),
            },
          };
          checks.push(dnsCheck);
          phase = 'https';
        }
      } else {
        phase = 'https';
        checks.push({
          name: 'https',
          status: 'ok',
          detail: 'TLS identity verified by the shared federation connector',
          evidence: {
            address: event.address,
            port: event.port,
            certificate: event.certificate,
          },
        });
      }
    };
    try {
      const resolved = await resolveFederationRoute(domain, {
        allowInsecureHttp: false,
        timeoutMs: config.connectTimeoutSec * 1000,
        observe,
      });
      route = {
        domain,
        host: resolved.connectHost,
        port: Number(new URL(resolved.baseUrl).port || 443),
        origin: resolved.baseUrl,
      };
      phase = 'dns';
      // Collected in parallel with the dial so both views describe the same moment.
      evidencePromise = resolveDnsEvidence(resolved.connectHost);
      dispatcher = createFederationDispatcher(
        resolved,
        config.connectTimeoutSec * 1000,
        { observe },
      );
      const response = await requestFederation(
        `${resolved.baseUrl}/.well-known/somfp`,
        dispatcher,
        {
          signal: AbortSignal.timeout(config.callTimeoutSec * 1000),
          headers: { accept: 'application/json' },
        },
      );
      phase = 'federation';
      const doc = await readFederationDiscovery(domain, response);
      checks.push({
        name: 'federation',
        status: 'ok',
        detail: 'Published root and signing certificates verified',
        evidence: {
          protocolVersions: doc.protocolVersions,
          roots: doc.roots,
          keys: doc.keys,
        },
      });
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause
          : error;
      checks.push({
        name: phase,
        status: 'fail',
        detail: cause instanceof Error ? cause.message : 'Diagnostic failed',
      });
    } finally {
      await mergeDnsEvidence(evidencePromise, dnsCheck);
      try {
        await dispatcher?.destroy();
      } finally {
        this.running = false;
        this.lastFinishedAt = Date.now();
      }
    }
    return {
      target: domain,
      route,
      checkedAt: startedAt,
      durationMs: Date.now() - startedAt,
      policy: {
        freshConnection: true,
        connectTimeoutMs: config.connectTimeoutSec * 1000,
        callTimeoutMs: config.callTimeoutSec * 1000,
      },
      checks,
    };
  }
}
