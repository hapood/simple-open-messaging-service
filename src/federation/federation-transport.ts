import { lookup } from 'node:dns';
import { resolveSrv } from 'node:dns/promises';
import {
  Agent,
  buildConnector,
  request as undiciRequest,
  type Dispatcher,
} from 'undici';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import {
  classifySomfpSrvRrset,
  selectSomfpSrvRecord,
  type SomfpSrvRrset,
} from './srv-rrset.js';
import {
  normalizeFederationDomain,
  validateWellKnownDocument,
} from './well-known-document.js';

export class FederationDomainResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FederationDomainResolutionError';
  }
}

export interface FederationRoute {
  domain: string;
  baseUrl: string;
  connectHost: string;
  srv: SomfpSrvRrset | null;
}
export interface FederationCertificateEvidence {
  subject: Record<string, string | string[] | undefined>;
  issuer: Record<string, string | string[] | undefined>;
  validFrom: string;
  validTo: string;
  fingerprint: string;
}
export type TransportObservation =
  | { phase: 'srv'; evidence: SomfpSrvRrset }
  | { phase: 'dns'; host: string; addresses: string[] }
  | {
      phase: 'tls';
      address: string;
      port: number;
      certificate: FederationCertificateEvidence | null;
    };
export interface TransportPolicy {
  observe?: (event: TransportObservation) => void;
}

/** One SRV resolver and selection policy for real traffic and isolated diagnostics. */
export async function resolveFederationRoute(
  input: string,
  options: {
    allowInsecureHttp: boolean;
    timeoutMs: number;
    observe?: TransportPolicy['observe'];
  },
): Promise<FederationRoute> {
  const domain = normalizeFederationDomain(input);
  if (options.allowInsecureHttp)
    return {
      domain,
      baseUrl: `http://${domain}`,
      connectHost: domain,
      srv: null,
    };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolveSrv(`_somfp._tcp.${domain}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('SRV deadline exceeded')),
          options.timeoutMs,
        );
      }),
    ]);
    const srv = classifySomfpSrvRrset(records);
    options.observe?.({ phase: 'srv', evidence: srv });
    if (srv.kind !== 'targets')
      throw new Error(
        srv.kind === 'disabled'
          ? `${domain} explicitly disables SOMFP`
          : srv.kind === 'empty'
            ? `${domain} does not publish SOMFP SRV`
            : `${domain} publishes an invalid SOMFP SRV RRset`,
      );
    const selected = selectSomfpSrvRecord(srv.records);
    const url = new URL(`https://${domain}`);
    url.port = String(selected.port);
    return { domain, baseUrl: url.origin, connectHost: selected.host, srv };
  } catch (error) {
    throw new FederationDomainResolutionError(
      `SRV discovery for ${domain} failed: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The shared Undici connector preserves logical HTTP/TLS authority while dialing the SRV host.
 * OS lookup ordering, address-family selection, TLS verification, and connect deadlines are identical
 * for business traffic and diagnostics. Observations never drive endpoint selection. */
export function createFederationDispatcher(
  route: Pick<FederationRoute, 'domain' | 'connectHost'>,
  connectTimeoutMs: number,
  policy: TransportPolicy = {},
): Agent {
  const connect = buildConnector({
    timeout: connectTimeoutMs,
    servername: route.domain,
    lookup: (_hostname, options, callback) => {
      lookup(
        route.connectHost,
        { ...options, all: true },
        (error, addresses) => {
          if (agent.destroyed || agent.closed)
            return callback(new Error('Federation dispatcher closed'), [], 0);
          if (error) return callback(error, [], 0);
          policy.observe?.({
            phase: 'dns',
            host: route.connectHost,
            addresses: addresses.map((entry) => entry.address),
          });
          if (options.all) callback(null, addresses);
          else if (addresses[0])
            callback(null, addresses[0].address, addresses[0].family);
          else callback(new Error('Destination has no IP addresses'), [], 0);
        },
      );
    },
  });
  const agent = new Agent({
    connectTimeout: connectTimeoutMs,
    connect: (options, callback) =>
      connect(options, (error, socket) => {
        if (error) return callback(error, null);
        const tls = socket as TLSSocket;
        const cert = tls.getPeerCertificate?.();
        policy.observe?.({
          phase: 'tls',
          address: socket.remoteAddress ?? '',
          port: socket.remotePort ?? Number(options.port),
          certificate: cert?.fingerprint256
            ? {
                subject: cert.subject,
                issuer: cert.issuer,
                validFrom: cert.valid_from,
                validTo: cert.valid_to,
                fingerprint: cert.fingerprint256,
              }
            : null,
        });
        callback(null, socket);
      }),
  });
  return agent;
}

/** Redirect handling and dispatch are shared by all federation HTTP callers. */
export async function requestFederation(
  url: URL | string,
  dispatcher: Agent | undefined,
  init: RequestInit = {},
  poolSignal?: AbortSignal,
  idleTimeoutMs = 30_000,
): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const signal = poolSignal
    ? init.signal
      ? AbortSignal.any([init.signal, poolSignal])
      : poolSignal
    : init.signal;
  // Undici starts the headers deadline only once the connection is ready to send
  // the request. Its body deadline resets on incoming data and respects backpressure.
  // fetch() overrides dispatcher deadlines, so use request() and adapt its body.
  const result = await undiciRequest(url, {
    method: (init.method ?? 'GET') as Dispatcher.HttpMethod,
    headers,
    body: init.body as string | undefined,
    signal,
    headersTimeout: idleTimeoutMs,
    bodyTimeout: idleTimeoutMs,
    ...(dispatcher ? { dispatcher } : {}),
  });
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(key, entry);
    } else if (value !== undefined) responseHeaders.set(key, value);
  }
  const noBody =
    init.method === 'HEAD' || [204, 205, 304].includes(result.statusCode);
  if (noBody) await result.body.dump();
  return new Response(
    noBody
      ? null
      : (Readable.toWeb(result.body, {
          strategy: {
            highWaterMark: 64 * 1024,
            size: (chunk: Uint8Array) => chunk.byteLength,
          },
        }) as ReadableStream<Uint8Array>),
    { status: result.statusCode, headers: responseHeaders },
  );
}

/** Identical content-type, size, JSON, and signature validation for discovery consumers. */
export async function readFederationDiscovery(
  domain: string,
  response: Response,
) {
  try {
    if (response.status !== 200)
      throw new Error(`well-known ${domain}: HTTP ${response.status}`);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new Error(`well-known ${domain}: invalid Content-Type`);
    if (!response.body) throw new Error(`well-known ${domain}: missing body`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024)
          throw new Error('Discovery response exceeds 256 KiB');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return validateWellKnownDocument(
      domain,
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
  } finally {
    if (!response.body?.locked)
      await response.body?.cancel().catch(() => undefined);
  }
}
