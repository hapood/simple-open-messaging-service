import { Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** undici fetch's Response type (its module does not export a named `Response` re-export reliably
 *  across versions, so derive it from the function return). */
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;
import ipaddr from 'ipaddr.js';

/**
 * SSRF-safe outbound fetch for the link-preview feature. This is the ONLY place in the codebase that
 * fetches an arbitrary user-supplied URL — every other outbound HTTP (federation) is scoped to
 * admin-trusted peer domains. Fetching a user-controlled target is an SSRF amplification surface, so
 * every request here passes through:
 *
 * 1. Shape validation — http(s) only, no userinfo, no .onion/.i2p, bounded length.
 * 2. DNS resolution + IP classification — reject private/loopback/link-local/reserved/CGNAT/0.0.0.0/8
 *    /multicast addresses (and IPv4-mapped IPv6, the classic ::ffff:0:0/96 bypass).
 * 3. Connect-time IP pinning — the TCP connect uses a custom `lookup` returning the address we already
 *    validated, with NO second DNS call. This closes DNS rebinding (a host that returns a public IP to
 *    the validator then a private IP at connect time cannot be reached).
 * 4. Manual redirect handling — each `Location` hop is re-resolved + re-classified from scratch, capped
 *    at MAX_REDIRECTS, so a chain cannot land on an internal address at hop N.
 * 5. Hard limits — connect + overall timeouts, a streaming body-size cap (aborts mid-download rather
 *    than buffering an attacker's terabyte stream), and content-type enforcement.
 *
 * Every public method returns null on any failure (never throws) so the caller can degrade to a
 * bare-link card instead of failing the message send.
 */
@Injectable()
export class SafeFetchService {
  private readonly logger = new Logger(SafeFetchService.name);

  /** Fetch a text/html document. Returns the body + the final (post-redirect) URL, or null. */
  async fetchHtml(
    rawUrl: string,
  ): Promise<{ body: string; finalUrl: string } | null> {
    const r = await this.safeGet(rawUrl, 'text/html,application/xhtml+xml', MAX_HTML_BYTES);
    if (!r) return null;
    if (!r.contentType.startsWith('text/html')) return null;
    return { body: r.body.toString('utf8'), finalUrl: r.finalUrl };
  }

  /** Fetch an image. Returns the raw bytes + content-type, or null. */
  async fetchImage(
    rawUrl: string,
  ): Promise<{ buf: Buffer; contentType: string } | null> {
    const r = await this.safeGet(rawUrl, 'image/*', MAX_IMAGE_BYTES);
    if (!r) return null;
    if (!r.contentType.startsWith('image/')) return null;
    return { buf: r.body, contentType: r.contentType };
  }

  /** Core SSRF-safe GET: manual redirect loop, connect-time IP pin (per hop), streaming size cap. */
  private async safeGet(
    rawUrl: string,
    accept: string,
    maxBytes: number,
  ): Promise<{ body: Buffer; finalUrl: string; contentType: string } | null> {
    let url: URL;
    try {
      url = this.validateUrlShape(rawUrl);
    } catch {
      return null;
    }
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const ips = await this.resolveAndClassify(url.hostname);
        const r = await this.fetchHop(url, ips, accept, maxBytes);
        if (!r) return null;
        if (r.kind === 'redirect') {
          url = r.url;
          continue;
        }
        return { body: r.body, finalUrl: url.href, contentType: r.contentType };
      }
      return null; // too many redirects
    } catch {
      return null;
    }
  }

  /** One SSRF-pinned fetch + its redirect/body decision. The pinned Agent is created here and CLOSED in
   *  the finally — each redirect hop needs its own IP pin, so one Agent per hop; closing it releases the
   *  keep-alive socket pool instead of leaking it across a redirect chain. */
  private async fetchHop(
    url: URL,
    ips: Array<{ address: string; family: number }>,
    accept: string,
    maxBytes: number,
  ): Promise<
    | { kind: 'redirect'; url: URL }
    | { kind: 'ok'; body: Buffer; contentType: string }
    | null
  > {
    const dispatcher = this.pinnedDispatcher(ips);
    try {
      let res: UndiciResponse;
      try {
        res = await undiciFetch(url, {
          method: 'GET',
          redirect: 'manual',
          dispatcher,
          headers: { 'User-Agent': USER_AGENT, Accept: accept },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        this.logger.debug(`fetch error ${url.href}: ${(e as Error).message}`);
        return null;
      }
      // 3xx: drain + follow the Location as a freshly re-validated target.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await this.drain(res);
        if (!loc) return null;
        try {
          return {
            kind: 'redirect',
            url: this.validateUrlShape(new URL(loc, url.href).href),
          };
        } catch {
          return null;
        }
      }
      if (res.status < 200 || res.status >= 300) {
        await this.drain(res);
        return null;
      }
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const body = await this.readCapped(res.body, maxBytes);
      return { kind: 'ok', body, contentType };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }

  /** Stream a response body into a Buffer, aborting (and throwing) once `maxBytes` is exceeded — a
   *  streaming cap so an attacker cannot exhaust memory with an endless body. */
  private async readCapped(
    body: UndiciResponse['body'],
    maxBytes: number,
  ): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    const stream = body as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`body exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  }

  /** Consume + discard a response body so its socket returns to the keep-alive pool (undici's
   *  Response.dump). Best-effort — a failure simply tears the connection down. */
  private async drain(res: UndiciResponse): Promise<void> {
    try {
      await (res as unknown as { dump?: () => Promise<unknown> }).dump?.();
    } catch {
      // ignore
    }
  }

  /** Build an undici Agent whose connect pins to one of the pre-validated IPs. The validator resolved
   *  the host once; connect never re-resolves, so DNS rebinding (public at validate time, private at
   *  connect time) is impossible. */
  private pinnedDispatcher(ips: Array<{ address: string; family: number }>): Dispatcher {
    const first = ips[0];
    return new Agent({
      connect: {
        timeout: CONNECT_TIMEOUT_MS,
        lookup: (_host, _opts, cb) => cb(null, first.address, first.family),
      },
    });
  }

  /** Resolve the hostname and reject if ANY resolved address is non-public (it takes only one private
   *  record to be an SSRF vector). Returns the validated addresses for connect pinning. */
  private async resolveAndClassify(
    host: string,
  ): Promise<Array<{ address: string; family: number }>> {
    let entries: Array<{ address: string; family: number }>;
    try {
      entries = await dnsLookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error(`dns lookup failed: ${host}`);
    }
    if (entries.length === 0) throw new Error(`no dns records: ${host}`);
    for (const e of entries) {
      if (!this.isPublicIp(e.address)) {
        throw new Error(`blocked address ${e.address} for ${host}`);
      }
    }
    return entries;
  }

  /** Classify a resolved IP as public. ipaddr.js `range()` names the standard private/reserved
   *  ranges; we additionally block CGNAT (100.64.0.0/10) and 0.0.0.0/8 explicitly (range() treats the
   *  former as ordinary internet), and unwrap IPv4-mapped IPv6 before classifying. */
  private isPublicIp(address: string): boolean {
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.parse(address);
    } catch {
      return false;
    }
    if (parsed.kind() === 'ipv6') {
      // IPv4-mapped IPv6 (::ffff:a.b.c.d): unwrap + classify the inner IPv4 (the standard bypass).
      try {
        parsed = (parsed as ipaddr.IPv6).toIPv4Address();
      } catch {
        // genuine IPv6 — classify below
      }
    }
    if (BLOCKED_RANGES.has(parsed.range())) return false;
    if (parsed.kind() === 'ipv4') {
      const v4 = parsed as ipaddr.IPv4;
      for (const [net, bits] of EXTRA_BLOCKED_IPV4) {
        if (v4.match(net, bits)) return false;
      }
    }
    return true;
  }

  /** Reject non-http(s), userinfo, darknet, empty-host, or overlong URLs. */
  private validateUrlShape(rawUrl: string): URL {
    if (rawUrl.length > MAX_URL_LEN) throw new Error('url too long');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('invalid url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`disallowed scheme ${url.protocol}`);
    }
    if (!url.hostname) throw new Error('empty host');
    if (url.username || url.password) throw new Error('userinfo not allowed');
    const host = url.hostname.toLowerCase();
    if (host.endsWith('.onion') || host.endsWith('.i2p')) {
      throw new Error('darknet host');
    }
    return url;
  }
}

const USER_AGENT = 'SOMSLinkPreview/1.0 (+link card)';
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024; // 1 MB
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB og:image download cap
const MAX_REDIRECTS = 5;
const MAX_URL_LEN = 2048;

/** ipaddr.js `range()` values that must never be an outbound target. */
const BLOCKED_RANGES = new Set([
  'unspecified',
  'private',
  'loopback',
  'linkLocal',
  'reserved',
  'multicast',
  'broadcast',
  'uniqueLocal',
]);

/** IPv4 ranges ipaddr.js `range()` does NOT classify as non-internet, blocked explicitly here. */
const EXTRA_BLOCKED_IPV4: Array<[ipaddr.IPv4, number]> = [
  ipaddr.parseCIDR('100.64.0.0/10') as [ipaddr.IPv4, number], // CGNAT
  ipaddr.parseCIDR('0.0.0.0/8') as [ipaddr.IPv4, number], // "this network"
];
