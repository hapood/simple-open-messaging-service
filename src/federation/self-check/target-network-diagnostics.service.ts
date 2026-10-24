import {
  BadRequestException,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { isPublicAddress } from './network-inspection.service.js';
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
type Check = CheckBase &
  (
    | { name: 'srv'; evidence?: SomfpSrvRrset }
    | { name: 'dns'; evidence?: { host: string; addresses: string[] } }
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

/** A fresh, isolated use of the real federation transport. No trust or business state is changed. */
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
        checks.push({
          name: 'dns',
          status: 'ok',
          detail: event.host,
          evidence: { host: event.host, addresses: event.addresses },
        });
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
      dispatcher = createFederationDispatcher(
        resolved,
        config.connectTimeoutSec * 1000,
        {
          observe,
          validateAddresses: (addresses) => {
            if (
              !addresses.length ||
              addresses.some((address) => !isPublicAddress(address))
            )
              throw new Error(
                'Diagnostic safety policy rejects non-public or empty DNS answers; ordinary federation may allow this destination',
              );
            phase = 'https';
          },
        },
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
        publicDestinationsOnly: true,
        connectTimeoutMs: config.connectTimeoutSec * 1000,
        callTimeoutMs: config.callTimeoutSec * 1000,
      },
      checks,
    };
  }
}
