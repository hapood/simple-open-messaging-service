import {
  BadRequestException,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { isPublicAddress } from './network-inspection.service.js';
import { validateWellKnownDocument } from '../well-known-document.js';
import { classifySomfpSrvRrset, type SomfpSrvRrset } from '../srv-rrset.js';
import type {
  RootKeyEntry,
  SigningKeyCertificate,
} from '../federation-certificate.js';

export function parseDiagnosticTarget(input: string): URL {
  let url: URL;
  try {
    if (!input.trim() || input.length > 2048) throw new Error();
    url = new URL(
      input.includes('://') ? input.trim() : `https://${input.trim()}`,
    );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!hostname || (isIP(hostname) && !isPublicAddress(hostname)))
      throw new Error();
  } catch {
    throw new BadRequestException(
      'Enter a public HTTPS URL without credentials, query, or fragment',
    );
  }
  // This tool diagnoses the service origin, never arbitrary application paths.
  return new URL(url.origin);
}

interface CertificateEvidence {
  subject: Record<string, string | string[] | undefined>;
  issuer: Record<string, string | string[] | undefined>;
  validFrom: string;
  validTo: string;
  fingerprint: string;
}
interface HttpProbeResponse {
  statusCode: number;
  body: string;
  certificate: CertificateEvidence | null;
}
type CheckBase = { status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string };
type Check = CheckBase &
  (
    | {
        name: 'dns';
        evidence?: { addresses: string[]; testedAddresses: string[] };
      }
    | { name: 'srv'; evidence?: SomfpSrvRrset }
    | {
        name: 'https';
        evidence: {
          address: string;
          port: number;
          certificate?: CertificateEvidence | null;
        };
      }
    | {
        name: 'federation';
        evidence: {
          address: string;
          protocolVersions?: number[];
          roots?: RootKeyEntry[];
          keys?: SigningKeyCertificate[];
        };
      }
  );

/** Explicit-target, read-only diagnostics. Validated IPs are pinned to the socket to prevent rebinding. */
@Injectable()
export class TargetNetworkDiagnosticsService {
  private running = false;
  private lastFinishedAt = 0;

  async run(input: string) {
    const target = parseDiagnosticTarget(input);
    if (this.running || Date.now() - this.lastFinishedAt < 3000)
      throw new HttpException(
        'A diagnostic is running or cooling down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.running = true;
    const startedAt = Date.now();
    const checks: Check[] = [];
    try {
      const hostname = target.hostname.replace(/^\[|\]$/g, '');
      const [addresses, srv] = await Promise.all([
        this.resolve(hostname),
        this.resolveSrv(hostname),
      ]);
      checks.push(srv);
      if (!addresses.length || addresses.some((ip) => !isPublicAddress(ip)))
        throw new Error('Destination has non-public or no IP addresses');
      // Bound fan-out while including both address families when available.
      const v4 = addresses.filter((address) => isIP(address) === 4);
      const v6 = addresses.filter((address) => isIP(address) === 6);
      const ordered = Array.from(
        { length: Math.max(v4.length, v6.length) },
        (_, i) => [v4[i], v6[i]],
      )
        .flat()
        .filter((address): address is string => !!address);
      const testedAddresses = ordered.slice(0, 8);
      checks.push({
        name: 'dns',
        status: addresses.length > 8 ? 'warn' : 'ok',
        detail:
          addresses.length > 8
            ? 'Testing the first eight addresses (fan-out limit)'
            : hostname,
        evidence: { addresses, testedAddresses },
      });
      const results = await Promise.all(
        testedAddresses.map((address) =>
          this.probeAddress(target, hostname, address),
        ),
      );
      checks.push(...results.flat());
    } catch (error) {
      checks.push({
        name: 'dns',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'Diagnostic failed',
      });
    } finally {
      this.running = false;
      this.lastFinishedAt = Date.now();
    }
    return {
      target: target.origin,
      checkedAt: startedAt,
      durationMs: Date.now() - startedAt,
      checks,
    };
  }

  private async resolveSrv(hostname: string): Promise<Check> {
    if (isIP(hostname))
      return {
        name: 'srv',
        status: 'skip',
        detail: 'SRV discovery requires a domain name',
      };
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    const timer = setTimeout(() => resolver.cancel(), 3000);
    try {
      const evidence = classifySomfpSrvRrset(
        await resolver.resolveSrv(`_somfp._tcp.${hostname}`),
      );
      return {
        name: 'srv',
        status: evidence.kind === 'invalid' ? 'warn' : 'ok',
        detail:
          'Published SRV records only; HTTPS probes use the explicit input origin, not these targets',
        evidence,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        name: 'srv',
        status: code === 'ENODATA' || code === 'ENOTFOUND' ? 'skip' : 'warn',
        detail: `SRV lookup: ${code ?? 'failed'}`,
      };
    } finally {
      clearTimeout(timer);
      resolver.cancel();
    }
  }

  private async probeAddress(
    target: URL,
    hostname: string,
    address: string,
  ): Promise<Check[]> {
    const checks: Check[] = [];
    try {
      const response = await this.fetch(target, address);
      checks.push({
        name: 'https',
        status: 'ok',
        detail: `TLS verified; HTTP ${response.statusCode}`,
        evidence: {
          address,
          port: Number(target.port || 443),
          certificate: response.certificate,
        },
      });
      if (response.statusCode === 404 || response.statusCode === 410) {
        checks.push({
          name: 'federation',
          status: 'skip',
          detail: 'No federation discovery document published',
          evidence: { address },
        });
      } else if (response.statusCode !== 200) {
        checks.push({
          name: 'federation',
          status: 'warn',
          detail: `Discovery returned HTTP ${response.statusCode}; redirects are not followed`,
          evidence: { address },
        });
      } else {
        try {
          const doc = validateWellKnownDocument(
            hostname,
            JSON.parse(response.body),
          );
          checks.push({
            name: 'federation',
            status: 'ok',
            detail: 'Published root and signing certificates verified',
            evidence: {
              address,
              protocolVersions: doc.protocolVersions,
              roots: doc.roots,
              keys: doc.keys,
            },
          });
        } catch {
          checks.push({
            name: 'federation',
            status: 'warn',
            detail: 'Response is not a valid federation discovery document',
            evidence: { address },
          });
        }
      }
    } catch (error) {
      checks.push({
        name: 'https',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'HTTPS failed',
        evidence: { address, port: Number(target.port || 443) },
      });
    }
    return checks;
  }

  private async resolve(hostname: string): Promise<string[]> {
    if (isIP(hostname)) return [hostname];
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([
          resolver.resolve4(hostname),
          resolver.resolve6(hostname),
        ]).then((answers) =>
          answers.flatMap((answer) =>
            answer.status === 'fulfilled' ? answer.value : [],
          ),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            resolver.cancel();
            reject(new Error('DNS deadline exceeded'));
          }, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      resolver.cancel();
    }
  }

  private fetch(target: URL, address: string): Promise<HttpProbeResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        result?: Parameters<typeof resolve>[0],
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(() => {
        finish(new Error('HTTPS deadline exceeded'));
        req.destroy();
      }, 7000);
      let certificate: Awaited<Parameters<typeof resolve>[0]>['certificate'] =
        null;
      const req = request(
        new URL('/.well-known/somfp', target),
        {
          agent: false,
          family: isIP(address),
          lookup: (_hostname, _options, callback) =>
            callback(null, address, isIP(address)),
          headers: {
            Accept: 'application/json',
            'User-Agent': 'SOMS-Network-Diagnostics/1.0',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) {
              finish(new Error('Discovery response exceeds 256 KiB'));
              res.destroy();
              req.destroy();
            } else chunks.push(chunk);
          });
          res.on('error', (error) => finish(error));
          res.on('end', () =>
            finish(undefined, {
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              certificate,
            }),
          );
        },
      );
      req.on('socket', (socket) => {
        (socket as TLSSocket).on('secureConnect', () => {
          const cert = (socket as TLSSocket).getPeerCertificate();
          certificate = {
            subject: cert.subject,
            issuer: cert.issuer,
            validFrom: cert.valid_from,
            validTo: cert.valid_to,
            fingerprint: cert.fingerprint256,
          };
        });
      });
      req.on('error', (error) => finish(error));
      req.end();
    });
  }
}
