import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { createSocket } from 'node:dgram';
import { X509Certificate, type KeyObject, createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  connect as http2Connect,
  constants as http2Constants,
} from 'node:http2';
import { KeypairService } from '../federation/keypair.service.js';
import {
  SignatureService,
  type SignedRequest,
} from '../federation/signature.service.js';
import {
  loadFederationConfig,
  type FederationConfig,
} from '../federation/federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import {
  FederationTransportConfigService,
  type FederationTransportConfig,
} from '../federation/federation-transport-config.service.js';

type SelfCheckConfig = FederationConfig & FederationTransportConfig;

/**
 * S2S handshake self-check — diagnoses whether THIS server's federation prerequisites are correctly
 * exposed to OTHER servers, from the external viewpoint (resolve our own public DNS → TLS → .well-known
 * → key consistency → signature loopback → clock). Strictly READ-ONLY: it never mutates FederatedPeer
 * trust state and never writes the S2SKeyCache — it does its own dns lookups + bare fetches and does NOT
 * inject DiscoveryService (whose getPublicKey() UPSERTs the cache). Each network check is run per
 * resolved IP (SRV→DDNS or multi-A/AAAA records means each IP can have a different cert / reachability),
 * so a single check's evidence carries an `ips[]` array with one entry per resolved address.
 */
@Injectable()
export class FederationSelfCheckService {
  private readonly logger = new Logger(FederationSelfCheckService.name);
  /** Minimum interval between runs (no project-wide throttler; this is a manually-triggered admin probe
   *  doing real outbound DNS+TLS+HTTP+NTP work, so a light guard prevents a double-click amplifier). */
  private static readonly RATE_LIMIT_MS = 10_000;
  private static readonly NTP_PORT = 123;
  private static readonly NTP_EPOCH_OFFSET = 2208988800; // seconds: 1900 (NTP epoch) → 1970 (UNIX)
  private static readonly NTP_TIMEOUT_MS = 5000;
  private static readonly TCP_PROBE_TIMEOUT_MS = 3000;
  private static readonly CLOCK_WARN_SEC = 60;
  private static readonly CLOCK_FAIL_SEC = 300;
  private static readonly CERT_WARN_DAYS = 30;
  private static readonly CERT_FAIL_DAYS = 7;
  private static readonly KEY_AGE_WARN_DAYS = 7;

  /** Default reference clock — a China-friendly public NTP source (Aliyun). Overridable per request. */
  static readonly DEFAULT_NTP = 'ntp.aliyun.com';

  private lastRunAt = 0;
  private inflight: Promise<SelfCheckReport> | null = null;

  constructor(
    private readonly keypair: KeypairService,
    private readonly signature: SignatureService,
    private readonly transportConfig: FederationTransportConfigService,
  ) {}

  /** Run the full probe set. Rate-limited + single-flight (a second concurrent call reuses the running one). */
  async run(opts: RunOptions): Promise<SelfCheckReport> {
    if (this.inflight) return this.inflight;
    const now = Date.now();
    if (now - this.lastRunAt < FederationSelfCheckService.RATE_LIMIT_MS) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'self-check rate limited; try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.inflight = this.doRun(opts).finally(() => {
      this.inflight = null;
      this.lastRunAt = Date.now();
    });
    return this.inflight;
  }

  private async doRun(opts: RunOptions): Promise<SelfCheckReport> {
    const startedAt = Date.now();
    const config: SelfCheckConfig = {
      ...loadFederationConfig(),
      ...this.transportConfig.get(),
    };
    const domain = config.domain;
    const resolver = this.makeResolver(opts.dnsResolver);
    const ntpServer =
      (opts.ntpServer ?? FederationSelfCheckService.DEFAULT_NTP).trim() ||
      FederationSelfCheckService.DEFAULT_NTP;

    // --- A. local configuration ---
    const checks: SelfCheckCheck[] = [];
    checks.push(
      await this.runOne(
        { key: 'config', group: 'config', title: 'Local configuration' },
        () => this.checkConfig(config),
      ),
    );
    checks.push(
      await this.runOne(
        {
          key: 'key-material',
          group: 'config',
          title: 'Database key material',
        },
        () => this.checkKeyMaterial(),
      ),
    );
    checks.push(
      await this.runOne(
        { key: 'key-age', group: 'config', title: 'Keypair age' },
        () => this.checkKeyAge(),
      ),
    );

    // --- B. DNS resolution (shared target for everything below) ---
    const target = await this.resolveTarget(resolver, domain, config);
    checks.push(
      await this.runOne(
        { key: 'dns-srv', group: 'dns', title: 'SRV record _somfp._tcp' },
        () => this.checkDnsSrv(domain, target),
      ),
    );
    const v4 = await this.safeResolve(resolver, domain, target, 4);
    const v6 = await this.safeResolve(resolver, domain, target, 6);
    checks.push(
      await this.runOne(
        { key: 'dns-a', group: 'dns', title: 'A records (IPv4)' },
        () => this.checkDnsA(v4),
      ),
    );
    checks.push(
      await this.runOne(
        { key: 'dns-aaaa', group: 'dns', title: 'AAAA records (IPv6)' },
        () => this.checkDnsAaaa(v6),
      ),
    );
    const ips = [
      ...v4.map((ip) => ({ ip, family: 4 as const })),
      ...v6.map((ip) => ({ ip, family: 6 as const })),
    ];

    // --- C. TLS (per IP) ---
    const tlsProbes: IpTlsProbe[] = config.allowInsecureHttp
      ? []
      : await Promise.all(
          ips.map((a) =>
            this.probeTls(a.ip, a.family, target.host, target.port, config),
          ),
        );
    checks.push(
      await this.runOne(
        { key: 'tls-public', group: 'tls', title: 'TLS certificate (per IP)' },
        () => this.checkTlsPublic(ips, tlsProbes, target, config),
      ),
    );
    const publicReachableAny = tlsProbes.some((p) => p.reachable);
    const hasLocalTls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
    const needsLoopback =
      config.allowInsecureHttp ||
      !hasLocalTls ||
      (!publicReachableAny && ips.length > 0);
    checks.push(
      await this.runOne(
        { key: 'tls-loopback', group: 'tls', title: 'Local process loopback' },
        () =>
          needsLoopback
            ? this.checkTlsLoopback()
            : this.skip('Public TLS verified; loopback probe not needed'),
      ),
    );

    // --- D. .well-known (per IP) ---
    const wkProbes: IpWellKnownProbe[] = await Promise.all(
      ips.map((a) =>
        this.probeWellKnown(
          a.ip,
          a.family,
          target.host,
          target.port,
          target.scheme,
          config,
          tlsProbes.find((p) => p.ip === a.ip)?.cert?.alpn ?? null,
        ),
      ),
    );
    checks.push(
      await this.runOne(
        {
          key: 'well-known',
          group: 'well-known',
          title: '.well-known/somfp (per IP)',
        },
        () => this.checkWellKnown(ips, wkProbes),
      ),
    );

    // --- E. crypto consistency (uses the first IP that returned a valid doc) ---
    const doc = wkProbes.find((p) => p.doc && p.keysValid)?.doc ?? null;
    checks.push(
      await this.runOne(
        {
          key: 'key-consistency',
          group: 'crypto',
          title: 'Published key consistency',
        },
        () => this.checkKeyConsistency(domain, doc),
      ),
    );
    checks.push(
      await this.runOne(
        { key: 'sign-loopback', group: 'crypto', title: 'Signature loopback' },
        () => this.checkSignLoopback(doc, target.authority),
      ),
    );

    // --- F. clock ---
    checks.push(
      await this.runOne(
        { key: 'clock-skew', group: 'clock', title: 'Clock skew (NTP)' },
        () => this.checkClockSkew(ntpServer),
      ),
    );

    const summary = this.summarize(checks);
    return {
      domain,
      runAt: startedAt,
      durationMs: Date.now() - startedAt,
      summary,
      target: {
        host: target.host,
        port: target.port,
        scheme: target.scheme,
        hasSrv: target.hasSrv,
      },
      resolver: opts.dnsResolver ?? 'system',
      ntpServer,
      checks,
    };
  }

  // ─────────────────────────── checks ───────────────────────────

  private async checkConfig(config: SelfCheckConfig): Promise<CheckBody> {
    const issues: string[] = [];
    let keyOk = true;
    try {
      const kid = this.keypair.getKeyId();
      const pub = this.keypair.getPublicKeyB64();
      const priv = this.keypair.getPrivateKey();
      if (!kid || !pub || priv.length !== 32) {
        keyOk = false;
        issues.push('keypair fields incomplete or private key not 32 bytes');
      }
    } catch (e) {
      keyOk = false;
      issues.push(`keypair unusable: ${(e as Error).message}`);
    }
    const prodInsecure =
      config.allowInsecureHttp && process.env.NODE_ENV === 'production';
    if (prodInsecure)
      issues.push(
        'CRITICAL: allowInsecureHttp is ON in production (protocol is HTTPS-only)',
      );
    else if (config.allowInsecureHttp)
      issues.push('allowInsecureHttp is ON (dev-only)');

    let status: SelfCheckStatus = keyOk ? 'ok' : 'fail';
    if (prodInsecure) status = 'fail';
    else if (config.allowInsecureHttp && status === 'ok') status = 'warn';

    const detail =
      issues.length === 0
        ? `SOMS_DOMAIN=${config.domain}; keypair loaded & usable`
        : issues.join('; ');
    return {
      status,
      detail,
      evidence: {
        domain: config.domain,
        keyId: this.safeKeyId(),
        allowInsecureHttp: config.allowInsecureHttp,
        nodeEnv: process.env.NODE_ENV ?? null,
        tlsConfigured: Boolean(process.env.TLS_CERT && process.env.TLS_KEY),
        listenPort: Number(process.env.PORT ?? 3000),
      },
    };
  }

  /** Federation private keys live in the database (access control is the secret boundary).
   *  Verify the service holds usable material: availability, well-formed root material, and a
   *  current signing key inside its validity interval. */
  private async checkKeyMaterial(): Promise<CheckBody> {
    const status = this.keypair.getStatus();
    if (!status.available) {
      return {
        status: 'fail',
        detail: `local federation identity unavailable: ${status.reason}`,
      };
    }
    try {
      const rootPublicKey = this.keypair.getRootPublicKeyB64();
      const fingerprint = this.keypair.getRootKeyFingerprint();
      if (
        !/^[A-Za-z0-9+/]{43}=$/.test(rootPublicKey) ||
        !/^sha256:[A-Za-z0-9_-]{43}$/.test(fingerprint)
      ) {
        return {
          status: 'fail',
          detail: 'stored root key material is malformed',
          evidence: { fingerprint },
        };
      }
      this.keypair.getKeyId(); // throws outside the current key validity interval
      this.keypair.getSigningKeyCertificates();
      return {
        status: 'ok',
        detail: `database key material usable (fingerprint ${fingerprint})`,
      };
    } catch (e) {
      return {
        status: 'fail',
        detail: `local key material unusable: ${(e as Error).message}`,
      };
    }
  }

  private async checkKeyAge(): Promise<CheckBody> {
    try {
      const created = this.keypair.getCreatedAt();
      const ageDays = Math.floor((Date.now() - created) / 86_400_000);
      if (ageDays < FederationSelfCheckService.KEY_AGE_WARN_DAYS) {
        return {
          status: 'warn',
          detail: `keypair created ${ageDays}d ago — confirm this is a new deployment or a documented rotation`,
          evidence: { createdAt: this.keypair.getCreatedAt(), ageDays },
        };
      }
      return {
        status: 'ok',
        detail: `keypair age ${ageDays}d`,
        evidence: { createdAt: this.keypair.getCreatedAt(), ageDays },
      };
    } catch (e) {
      return {
        status: 'skip',
        detail: `could not read keypair createdAt: ${(e as Error).message}`,
      };
    }
  }

  private async checkDnsSrv(
    domain: string,
    target: ResolvedTarget,
  ): Promise<CheckBody> {
    if (!target.hasSrv) {
      return {
        status: 'warn',
        detail: `no _somfp._tcp.${domain} SRV record — peers fall back to https://${domain}:443 (set SRV if not on :443)`,
        evidence: {
          domain,
          record: null,
          resolvedHost: target.host,
          resolvedPort: target.port,
        },
      };
    }
    return {
      status: 'ok',
      detail: `SRV → ${target.host}:${target.port}`,
      evidence: {
        domain,
        record: target.srvRecord,
        resolvedHost: target.host,
        resolvedPort: target.port,
      },
    };
  }

  private async checkDnsA(v4: string[]): Promise<CheckBody> {
    if (v4.length === 0)
      return {
        status: 'fail',
        detail: 'no A records resolved',
        evidence: { addresses: [] },
      };
    return {
      status: 'ok',
      detail: `${v4.length} A record(s): ${v4.join(', ')}`,
      evidence: { addresses: v4 },
    };
  }

  private async checkDnsAaaa(v6: string[]): Promise<CheckBody> {
    if (v6.length === 0)
      return {
        status: 'skip',
        detail: 'no AAAA records (IPv6 not published)',
        evidence: { addresses: [] },
      };
    return {
      status: 'ok',
      detail: `${v6.length} AAAA record(s): ${v6.join(', ')}`,
      evidence: { addresses: v6 },
    };
  }

  private async checkTlsPublic(
    ips: { ip: string; family: 4 | 6 }[],
    probes: IpTlsProbe[],
    target: ResolvedTarget,
    config: SelfCheckConfig,
  ): Promise<CheckBody> {
    if (config.allowInsecureHttp) {
      return {
        status: 'skip',
        detail:
          'allowInsecureHttp is ON — peers resolve http:// and do not validate a TLS cert',
        evidence: { host: target.host, scheme: target.scheme },
      };
    }
    if (ips.length === 0) {
      return {
        status: 'fail',
        detail: 'no IPs resolved to probe',
        evidence: { host: target.host, ips: [] },
      };
    }
    const status = this.worst(probes.map((p) => p.status));
    const okCount = probes.filter((p) => p.status === 'ok').length;
    const detail =
      okCount === probes.length
        ? `all ${probes.length} IP(s) present a valid, matching cert`
        : `${okCount}/${probes.length} IP(s) ok — see per-IP detail`;
    return {
      status,
      detail,
      evidence: {
        host: target.host,
        sni: target.host,
        port: target.port,
        ips: probes,
      },
    };
  }

  private async checkTlsLoopback(): Promise<CheckBody> {
    const port = Number(process.env.PORT ?? 3000);
    const hasLocalTls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
    const reachable = await this.tcpProbe('127.0.0.1', port);
    if (reachable) {
      return {
        status: hasLocalTls ? 'ok' : 'skip',
        detail: hasLocalTls
          ? `local TLS server reachable on 127.0.0.1:${port} — public reachability/cert problem is upstream (reverse proxy / NAT / firewall)`
          : `local process listening on 127.0.0.1:${port}; TLS is terminated by a reverse proxy so the origin cert is not inspectable here`,
        evidence: { host: '127.0.0.1', port, originTls: hasLocalTls },
      };
    }
    return {
      status: 'fail',
      detail: `local process NOT reachable on 127.0.0.1:${port} — the server may not be running`,
      evidence: { host: '127.0.0.1', port, originTls: hasLocalTls },
    };
  }

  private async checkWellKnown(
    ips: { ip: string; family: 4 | 6 }[],
    probes: IpWellKnownProbe[],
  ): Promise<CheckBody> {
    if (ips.length === 0)
      return {
        status: 'fail',
        detail: 'no IPs resolved to probe',
        evidence: { ips: [] },
      };
    const status = this.worst(probes.map((p) => p.status));
    const okCount = probes.filter((p) => p.status === 'ok').length;
    const sample = probes.find((p) => p.doc);
    const detail =
      okCount === probes.length
        ? `all ${probes.length} IP(s) serve a valid .well-known/somfp`
        : `${okCount}/${probes.length} IP(s) ok — see per-IP detail`;
    return {
      status,
      detail,
      evidence: {
        ips: probes,
        software: sample?.software ?? null,
        keyCount: sample?.keyCount ?? 0,
        keysValid: sample?.keysValid ?? false,
      },
    };
  }

  private async checkKeyConsistency(
    domain: string,
    doc: WellKnownDoc | null,
  ): Promise<CheckBody> {
    const localPub = this.keypair.getPublicKeyB64();
    const localSha = sha256B64(localPub);
    const keyId = this.safeKeyId();
    if (!doc) {
      return {
        status: 'skip',
        detail:
          '.well-known/somfp unavailable — published key comparison was not run',
        blockedBy: 'well-known',
        evidence: { localPubB64: localPub, localPubSha256: localSha, keyId },
      };
    }
    const keyIdDomain = keyId.split('/')[0];
    const published = doc.keys.map((k) => k.ed25519);
    const keyMatch = published.includes(localPub);
    const domainMatch = keyIdDomain === domain;
    const issues: string[] = [];
    if (!keyMatch)
      issues.push(
        'published key set does NOT include the local in-use public key (rotation drift?)',
      );
    if (!domainMatch)
      issues.push(`keyId domain "${keyIdDomain}" != SOMS_DOMAIN "${domain}"`);
    const status: SelfCheckStatus = keyMatch && domainMatch ? 'ok' : 'fail';
    return {
      status,
      detail:
        issues.length === 0
          ? 'local key is published; keyId domain matches SOMS_DOMAIN'
          : issues.join('; '),
      evidence: {
        localPubB64: localPub,
        localPubSha256: localSha,
        publishedPubB64: published[0] ?? null,
        publishedPubSha256: published[0] ? sha256B64(published[0]) : null,
        keyId,
        keyIdDomain,
        expectedDomain: domain,
        keyMatch,
        domainMatch,
        publishedKeyCount: published.length,
      },
    };
  }

  private async checkSignLoopback(
    doc: WellKnownDoc | null,
    authority: string,
  ): Promise<CheckBody> {
    if (!doc || doc.keys.length === 0) {
      return {
        status: 'skip',
        detail:
          '.well-known/somfp unavailable — signature loopback was not run',
        blockedBy: 'well-known',
        evidence: { authority },
      };
    }
    const ed = doc.keys[0].ed25519;
    const pub = Uint8Array.from(Buffer.from(ed, 'base64'));
    if (pub.length !== 32) {
      return {
        status: 'fail',
        detail: `published key is not 32 bytes (${pub.length})`,
        evidence: { authority },
      };
    }
    const req: SignedRequest = {
      method: 'POST',
      url: new URL(`https://${authority}/s2s/v1/recognize`),
      body: '{"probe":"self-check"}',
    };
    const headers = await this.signature.signOutbound(req);
    const ok = await this.signature.verifyWithKey(req, headers, pub);
    return {
      status: ok ? 'ok' : 'fail',
      detail: ok
        ? `RFC 9421 sign→verify loop passes (authority=${authority})`
        : 'sign→verify loop FAILED — keypair/signature implementation broken',
      evidence: {
        authority,
        verified: ok,
        keyId: headers['signature-input'].match(/keyid="([^"]+)"/)?.[1] ?? null,
      },
    };
  }

  private async checkClockSkew(ntpServer: string): Promise<CheckBody> {
    try {
      const { offsetSec, roundTripMs } = await this.queryNtp(ntpServer);
      const abs = Math.abs(offsetSec);
      let status: SelfCheckStatus = 'ok';
      if (abs > FederationSelfCheckService.CLOCK_FAIL_SEC) status = 'fail';
      else if (abs > FederationSelfCheckService.CLOCK_WARN_SEC) status = 'warn';
      const sign = offsetSec >= 0 ? '+' : '';
      return {
        status,
        detail:
          status === 'ok'
            ? `clock offset ${sign}${offsetSec.toFixed(1)}s (within ±${FederationSelfCheckService.CLOCK_WARN_SEC}s)`
            : `clock offset ${sign}${offsetSec.toFixed(1)}s — RFC 9421 Date header will be rejected by peers`,
        evidence: {
          ntpServer,
          offsetSec: Number(offsetSec.toFixed(2)),
          roundTripMs,
        },
      };
    } catch (e) {
      return {
        status: 'skip',
        detail: `NTP query to ${ntpServer} failed: ${(e as Error).message} (cannot measure skew)`,
        evidence: { ntpServer, error: (e as Error).message },
      };
    }
  }

  // ─────────────────────────── probes / IO ───────────────────────────

  private async probeTls(
    ip: string,
    family: 4 | 6,
    host: string,
    port: number,
    config: SelfCheckConfig,
  ): Promise<IpTlsProbe> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: IpTlsProbe) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const sock = tlsConnect(
        {
          host: ip, // dial the specific IP (SNI/hostname check still uses `host` below)
          servername: host, // SNI + checkServerIdentity target = the public hostname, not the IP
          port,
          rejectUnauthorized: true,
          ALPNProtocols: ['h2', 'http/1.1'],
        },
        () => {
          const peer = sock.getPeerCertificate(true) as PeerCert | undefined;
          if (!peer || !peer.raw) {
            sock.destroy();
            done({
              ip,
              family,
              reachable: true,
              status: 'fail',
              detail: 'handshake ok but no certificate presented',
              errorClass: 'cert',
            });
            return;
          }
          const cert = this.parseCert(peer.raw, host, sock.alpnProtocol);
          const chain = this.buildChain(peer);
          sock.destroy();
          let status: SelfCheckStatus = 'ok';
          let detail = `valid cert; expires in ${cert.daysToExpiry}d; ALPN ${cert.alpn ?? 'none'}`;
          if (!cert.sanMatched) {
            status = 'fail';
            detail = `cert SAN does NOT cover ${host}`;
          } else if (
            cert.daysToExpiry < FederationSelfCheckService.CERT_FAIL_DAYS
          ) {
            status = 'fail';
            detail = `cert EXPIRES in ${cert.daysToExpiry}d (< ${FederationSelfCheckService.CERT_FAIL_DAYS})`;
          } else if (
            cert.daysToExpiry < FederationSelfCheckService.CERT_WARN_DAYS
          ) {
            status = 'warn';
            detail = `cert expires in ${cert.daysToExpiry}d (< ${FederationSelfCheckService.CERT_WARN_DAYS})`;
          }
          done({
            ip,
            family,
            reachable: true,
            status,
            detail,
            cert,
            chain,
            chainComplete:
              chain.length > 0 ? !!chain[chain.length - 1].selfSigned : false,
          });
        },
      );
      sock.setTimeout(config.connectTimeoutSec * 1000, () => {
        sock.destroy(new Error('tls handshake timeout'));
      });
      sock.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        done({
          ip,
          family,
          reachable: false,
          status: 'fail',
          detail: `${code ?? err.message}`,
          errorClass: this.classifyErr(code),
          code: code ?? undefined,
        });
      });
    });
  }

  private async probeWellKnown(
    ip: string,
    family: 4 | 6,
    host: string,
    port: number,
    scheme: 'https' | 'http',
    config: SelfCheckConfig,
    negotiatedAlpn: string | null,
  ): Promise<IpWellKnownProbe> {
    if (scheme === 'https' && negotiatedAlpn === 'h2') {
      return this.probeWellKnownHttp2(ip, family, host, port, config);
    }
    return new Promise((resolve) => {
      const isTls = scheme === 'https';
      const baseOpts = {
        host: ip, // dial this specific IP …
        port,
        path: '/.well-known/somfp',
        method: 'GET',
        timeout: config.callTimeoutSec * 1000,
        headers: { host, accept: 'application/json' }, // … but send Host: <public hostname>
      };
      const onRes = (res: IncomingMessage) =>
        this.consumeWellKnownResponse(res, ip, family, resolve);
      // Separate branches (not a ternary over the request fn) so each options object is checked against
      // its own request signature — the TLS branch carries servername/rejectUnauthorized/ALPNProtocols.
      const req = isTls
        ? httpsRequest(
            // servername/rejectUnauthorized/ALPNProtocols are TLS options valid at runtime on
            // https.request; this @types/node RequestOptions union doesn't surface them, hence the cast.
            {
              ...baseOpts,
              servername: host,
              rejectUnauthorized: true,
              // node:https is an HTTP/1.1 client. Advertising h2 here lets the server select a
              // protocol this parser cannot consume (HPE_INVALID_CONSTANT).
              ALPNProtocols: ['http/1.1'],
            } as never,
            onRes,
          )
        : httpRequest(baseOpts, onRes);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        resolve({
          ip,
          family,
          reachable: false,
          status: 'fail',
          detail: `${code ?? err.message}`,
          errorClass: this.classifyErr(code),
          code: code ?? undefined,
          phase: 'http',
          httpVersion: '1.1',
        });
      });
      req.end();
    });
  }

  /** HTTP/2 branch selected from the TLS probe's ALPN result. It retains per-IP dialing while SNI and
   *  :authority use the public hostname, matching what a real peer observes. */
  private probeWellKnownHttp2(
    ip: string,
    family: 4 | 6,
    host: string,
    port: number,
    config: SelfCheckConfig,
  ): Promise<IpWellKnownProbe> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (probe: IpWellKnownProbe) => {
        if (settled) return;
        settled = true;
        client.close();
        resolve(probe);
      };
      const authority = `https://${host}:${port}`;
      const client = http2Connect(authority, {
        createConnection: () =>
          tlsConnect({
            host: ip,
            port,
            servername: host,
            rejectUnauthorized: true,
            ALPNProtocols: ['h2'],
          }),
      });
      client.setTimeout(config.callTimeoutSec * 1000, () =>
        client.destroy(new Error('timeout')),
      );
      client.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        done({
          ip,
          family,
          reachable: false,
          status: 'fail',
          detail: `${code ?? err.message}`,
          errorClass: this.classifyErr(code),
          code: code ?? undefined,
          phase: 'http',
          httpVersion: '2',
        });
      });
      const req = client.request({
        [http2Constants.HTTP2_HEADER_METHOD]: 'GET',
        [http2Constants.HTTP2_HEADER_PATH]: '/.well-known/somfp',
        [http2Constants.HTTP2_HEADER_AUTHORITY]: host,
        accept: 'application/json',
      });
      const chunks: Buffer[] = [];
      let status = 0;
      let contentType = '';
      req.on('response', (headers) => {
        status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
        contentType = String(
          headers[http2Constants.HTTP2_HEADER_CONTENT_TYPE] ?? '',
        );
      });
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () =>
        done(
          this.parseWellKnownResponse(
            ip,
            family,
            status,
            contentType,
            Buffer.concat(chunks).toString('utf8'),
            '2',
          ),
        ),
      );
      req.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        done({
          ip,
          family,
          reachable: false,
          status: 'fail',
          detail: `${code ?? err.message}`,
          errorClass: 'http',
          code,
          phase: 'http',
          httpVersion: '2',
        });
      });
      req.end();
    });
  }

  /** Shared response consumer for the per-IP .well-known probe (used by both http and https branches). */
  private consumeWellKnownResponse(
    res: IncomingMessage,
    ip: string,
    family: 4 | 6,
    resolve: (p: IpWellKnownProbe) => void,
  ): void {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const status = res.statusCode ?? 0;
      const ct = res.headers['content-type'];
      const contentType = typeof ct === 'string' ? ct : '';
      resolve(
        this.parseWellKnownResponse(
          ip,
          family,
          status,
          contentType,
          body,
          res.httpVersion,
        ),
      );
    });
  }

  private parseWellKnownResponse(
    ip: string,
    family: 4 | 6,
    status: number,
    contentType: string,
    body: string,
    httpVersion: string,
  ): IpWellKnownProbe {
    const probe: IpWellKnownProbe = {
      ip,
      family,
      reachable: true,
      status: 'ok',
      detail: '',
      httpStatus: status,
      contentType,
      phase: 'response',
      httpVersion,
    };
    if (status !== 200) {
      probe.status = 'fail';
      probe.errorClass = 'http';
      probe.detail = `HTTP ${status}`;
      return probe;
    }
    let doc: WellKnownDoc;
    try {
      doc = JSON.parse(body) as WellKnownDoc;
    } catch (e) {
      probe.status = 'fail';
      probe.errorClass = 'parse';
      probe.detail = `malformed JSON: ${(e as Error).message}`;
      probe.phase = 'parse';
      return probe;
    }
    probe.doc = doc;
    probe.software = doc.software ?? null;
    probe.keyCount = Array.isArray(doc.keys) ? doc.keys.length : 0;
    const keysValid =
      Array.isArray(doc.keys) &&
      doc.keys.every(
        (k) =>
          typeof k?.keyId === 'string' &&
          typeof k?.ed25519 === 'string' &&
          Buffer.from(k.ed25519, 'base64').length === 32,
      );
    probe.keysValid = keysValid;
    if (!doc.software || !doc.software.startsWith('soms/')) {
      probe.status = 'warn';
      probe.detail = `software="${doc.software ?? ''}" — expected a soms/ server (wrong target?)`;
    } else if (!keysValid) {
      probe.status = 'warn';
      probe.detail = 'keys missing or not valid 32-byte ed25519';
    } else {
      probe.detail = `software=${doc.software}; ${probe.keyCount} key(s)`;
    }
    return probe;
  }

  /** Plain TCP connect to prove the local process is listening (loopback probe). */
  private tcpProbe(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = netConnect({ host, port });
      const t = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, FederationSelfCheckService.TCP_PROBE_TIMEOUT_MS);
      sock.once('connect', () => {
        clearTimeout(t);
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
  }

  /** Minimal NTPv4 client (RFC 5905): one 48-byte UDP datagram, read the transmit timestamp (offset 40). */
  private queryNtp(
    server: string,
  ): Promise<{ offsetSec: number; roundTripMs: number }> {
    return new Promise((resolve, reject) => {
      const t1 = Date.now();
      const sock = createSocket('udp4');
      const packet = Buffer.alloc(48);
      packet[0] = 0x1b; // LI=0 · VN=3 · Mode=3 (client)
      const timer = setTimeout(() => {
        sock.close();
        reject(
          new Error(
            `timeout after ${FederationSelfCheckService.NTP_TIMEOUT_MS}ms`,
          ),
        );
      }, FederationSelfCheckService.NTP_TIMEOUT_MS);
      sock.on('error', (err) => {
        clearTimeout(timer);
        sock.close();
        reject(err);
      });
      sock.on('message', (msg: Buffer) => {
        clearTimeout(timer);
        const t4 = Date.now();
        const seconds = msg.readUInt32BE(40);
        const fraction = msg.readUInt32BE(44);
        const serverMs =
          (seconds - FederationSelfCheckService.NTP_EPOCH_OFFSET) * 1000 +
          (fraction / 0x100000000) * 1000;
        sock.close();
        // offset = server time − midpoint of the local round-trip window
        const offsetMs = serverMs - (t1 + t4) / 2;
        resolve({ offsetSec: offsetMs / 1000, roundTripMs: t4 - t1 });
      });
      sock.send(
        packet,
        0,
        48,
        FederationSelfCheckService.NTP_PORT,
        server,
        (err) => {
          if (err) {
            clearTimeout(timer);
            sock.close();
            reject(err);
          }
        },
      );
    });
  }

  // ─────────────────────────── DNS helpers ───────────────────────────

  private makeResolver(dnsResolver?: string): Resolver {
    const r = new Resolver();
    if (dnsResolver && dnsResolver !== 'system') {
      try {
        r.setServers([dnsResolver]);
      } catch (e) {
        this.logger.warn(
          `invalid dnsResolver "${dnsResolver}": ${(e as Error).message}; using system resolver`,
        );
      }
    }
    return r;
  }

  /** Resolve the federation target (SRV → host:port, fallback apex:defaultPort) exactly as a peer would. */
  private async resolveTarget(
    resolver: Resolver,
    domain: string,
    config: SelfCheckConfig,
  ): Promise<ResolvedTarget> {
    const scheme: 'https' | 'http' = config.allowInsecureHttp
      ? 'http'
      : 'https';
    const defaultPort = scheme === 'https' ? 443 : 80;
    let host = domain;
    let port: number | undefined;
    let srvRecord: string | null = null;
    let hasSrv = false;
    try {
      const records = await resolver.resolveSrv(`_somfp._tcp.${domain}`);
      if (records.length > 0) {
        records.sort((a, b) => a.priority - b.priority || a.weight - b.weight);
        const top = records[0];
        host = top.name.replace(/\.+$/, '');
        port = top.port;
        srvRecord = `${top.priority} ${top.weight} ${top.port} ${top.name}`;
        hasSrv = true;
      }
    } catch {
      // ENOTFOUND etc. → fall back to apex; the probes below are the real liveness test.
    }
    const portNum = port ?? defaultPort;
    const authority = portNum === defaultPort ? host : `${host}:${portNum}`;
    return { scheme, host, port: portNum, authority, srvRecord, hasSrv };
  }

  /** Resolve A (family=4) or AAAA (family=6) for the SRV target host; [] on any failure. */
  private async safeResolve(
    resolver: Resolver,
    domain: string,
    target: ResolvedTarget,
    family: 4 | 6,
  ): Promise<string[]> {
    try {
      // Resolve the SRV target host (or apex domain). For an apex deploy the host == domain.
      const host = target.hasSrv ? target.host : domain;
      return family === 4
        ? await resolver.resolve4(host)
        : await resolver.resolve6(host);
    } catch {
      return [];
    }
  }

  // ─────────────────────────── cert parsing ───────────────────────────

  private parseCert(
    raw: Buffer,
    host: string,
    alpn: string | false | null | undefined,
  ): CertInfo {
    const x = new X509Certificate(raw);
    let sanMatched = true;
    try {
      x.checkHost(host);
    } catch {
      sanMatched = false;
    }
    const validToDate = new Date(x.validTo);
    const daysToExpiry = Math.floor(
      (validToDate.getTime() - Date.now()) / 86_400_000,
    );
    return {
      subject: x.subject,
      issuer: x.issuer,
      subjectCN: this.extractCN(x.subject),
      issuerCN: this.extractCN(x.issuer),
      subjectAltName: x.subjectAltName ?? null,
      serialNumber: x.serialNumber,
      validFrom: x.validFrom,
      validTo: x.validTo,
      daysToExpiry,
      signatureAlgorithm: x.signatureAlgorithm ?? null,
      publicKey: this.describeKey(x.publicKey),
      fingerprintSha1: x.fingerprint,
      fingerprintSha256: x.fingerprint256,
      ca: !!x.ca,
      keyUsage: x.keyUsage ?? null,
      alpn: alpn || null,
      sanMatched,
    };
  }

  /** Walk the peer cert's issuer chain (legacy getPeerCertificate(true) object) up to the self-signed root. */
  private buildChain(peer: PeerCert): ChainNode[] {
    const chain: ChainNode[] = [];
    const seen = new Set<string>();
    let cur: PeerCert | undefined = peer;
    for (let i = 0; i < 12 && cur; i++) {
      const fp = cur.fingerprint256 ?? cur.fingerprint ?? '';
      if (!fp || seen.has(fp)) break;
      seen.add(fp);
      const subjectStr =
        typeof cur.subject === 'string'
          ? cur.subject
          : this.dnToString(cur.subject);
      const issuerStr =
        typeof cur.issuer === 'string'
          ? cur.issuer
          : this.dnToString(cur.issuer);
      chain.push({
        subject: subjectStr,
        issuer: issuerStr,
        subjectCN:
          typeof cur.subject === 'string'
            ? this.extractCN(cur.subject)
            : (cur.subject?.CN ?? null),
        validTo: cur.valid_to ?? null,
        selfSigned: subjectStr === issuerStr,
        isCA: !!cur.isCA,
      });
      cur = cur.issuerCertificate;
      if (cur === peer) break; // root's issuerCertificate loops back to itself
    }
    return chain;
  }

  private describeKey(pub: KeyObject): {
    algorithm: string | null;
    bits: number | null;
    curve: string | null;
  } {
    const details = (pub.asymmetricKeyDetails ?? {}) as Record<string, unknown>;
    return {
      algorithm: pub.asymmetricKeyType ?? null,
      bits:
        typeof details.modulusLength === 'number'
          ? details.modulusLength
          : null,
      curve:
        typeof details.namedCurve === 'string'
          ? (details.namedCurve as string)
          : null,
    };
  }

  private extractCN(dn: string): string | null {
    const m = dn.match(/(?:^|[,;\s])CN=([^,;]+)/);
    return m ? m[1] : null;
  }

  private dnToString(dn: Record<string, string> | undefined): string {
    if (!dn) return '';
    return Object.entries(dn)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }

  // ─────────────────────────── small utils ───────────────────────────

  private classifyErr(
    code: string | undefined,
  ): 'reachability' | 'cert' | 'timeout' {
    if (!code) return 'reachability';
    if (REACH_CODES.has(code)) return 'reachability';
    if (CERT_CODES.has(code)) return 'cert';
    if (code === 'CERT_HAS_EXPIRED' || code.includes('TIMEOUT'))
      return code === 'CERT_HAS_EXPIRED' ? 'cert' : 'timeout';
    return 'reachability';
  }

  private worst(statuses: SelfCheckStatus[]): SelfCheckStatus {
    if (statuses.includes('fail')) return 'fail';
    if (statuses.includes('warn')) return 'warn';
    if (statuses.includes('ok')) return 'ok';
    return 'skip';
  }

  private summarize(checks: SelfCheckCheck[]): SelfCheckSummary {
    const s = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of checks) s[c.status]++;
    return s;
  }

  private skip(detail: string): Promise<CheckBody> {
    return Promise.resolve({ status: 'skip', detail });
  }

  private safeKeyId(): string {
    try {
      return this.keypair.getKeyId();
    } catch {
      return '<unavailable>';
    }
  }

  private async runOne(
    meta: { key: string; group: SelfCheckGroup; title: string },
    fn: () => Promise<CheckBody>,
  ): Promise<SelfCheckCheck> {
    const t0 = Date.now();
    let body: CheckBody;
    try {
      body = await fn();
    } catch (e) {
      body = {
        status: 'fail',
        detail: `unexpected error: ${(e as Error).message}`,
        evidence: { error: String((e as Error).message) },
      };
    }
    return { ...meta, ...body, durationMs: Date.now() - t0 };
  }
}

const REACH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const CERT_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT',
  'ERR_TLS_CERT_ALTNAME',
]);

function sha256B64(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

// ─────────────────────────── types ───────────────────────────

export interface RunOptions {
  ntpServer?: string;
  dnsResolver?: string;
}

export type SelfCheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type SelfCheckGroup =
  | 'config'
  | 'dns'
  | 'tls'
  | 'well-known'
  | 'crypto'
  | 'clock';

interface CheckBody {
  status: SelfCheckStatus;
  detail: string;
  evidence?: Record<string, unknown>;
  blockedBy?: string;
}

export interface SelfCheckCheck extends CheckBody {
  key: string;
  group: SelfCheckGroup;
  title: string;
  durationMs: number;
}

export interface SelfCheckSummary {
  ok: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface SelfCheckReport {
  domain: string;
  runAt: number; // ms epoch
  durationMs: number;
  summary: SelfCheckSummary;
  target: {
    host: string;
    port: number;
    scheme: 'https' | 'http';
    hasSrv: boolean;
  };
  resolver: string;
  ntpServer: string;
  checks: SelfCheckCheck[];
}

interface ResolvedTarget {
  scheme: 'https' | 'http';
  host: string;
  port: number;
  authority: string;
  srvRecord: string | null;
  hasSrv: boolean;
}

interface WellKnownDoc {
  software?: string;
  keys: { keyId: string; ed25519: string }[];
}

interface CertInfo {
  subject: string;
  issuer: string;
  subjectCN: string | null;
  issuerCN: string | null;
  subjectAltName: string | null;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  daysToExpiry: number;
  signatureAlgorithm: string | null;
  publicKey: {
    algorithm: string | null;
    bits: number | null;
    curve: string | null;
  };
  fingerprintSha1: string;
  fingerprintSha256: string;
  ca: boolean;
  keyUsage: string[] | null;
  alpn: string | null;
  sanMatched: boolean;
}

interface ChainNode {
  subject: string;
  issuer: string;
  subjectCN: string | null;
  validTo: string | null;
  selfSigned: boolean;
  isCA: boolean;
}

interface IpTlsProbe {
  ip: string;
  family: 4 | 6;
  reachable: boolean;
  status: SelfCheckStatus;
  detail: string;
  cert?: CertInfo;
  chain?: ChainNode[];
  chainComplete?: boolean;
  errorClass?: 'reachability' | 'cert' | 'timeout';
  code?: string;
}

interface IpWellKnownProbe {
  ip: string;
  family: 4 | 6;
  reachable: boolean;
  status: SelfCheckStatus;
  detail: string;
  httpStatus?: number;
  contentType?: string;
  software?: string | null;
  keyCount?: number;
  keysValid?: boolean;
  doc?: WellKnownDoc;
  errorClass?: 'reachability' | 'cert' | 'timeout' | 'http' | 'parse';
  code?: string;
  phase?: 'connect' | 'tls' | 'http' | 'response' | 'parse';
  httpVersion?: string;
}

/** Shape of tls.TLSSocket.getPeerCertificate(true) — a legacy object with a circular issuerCertificate link. */
interface PeerCert {
  subject: string | Record<string, string>;
  issuer: string | Record<string, string>;
  valid_from?: string;
  valid_to?: string;
  fingerprint?: string;
  fingerprint256?: string;
  isCA?: boolean;
  raw?: Buffer;
  issuerCertificate?: PeerCert;
}
