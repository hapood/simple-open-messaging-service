import { Injectable } from '@nestjs/common';
import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';

/** Fixed HTTPS destinations; neither caller-supplied URLs nor redirects are allowed. */
export const IP_SOURCES = {
  'ip-sb': {
    label: 'IP.SB',
    ipv4: 'https://api-ipv4.ip.sb/ip',
    ipv6: 'https://api-ipv6.ip.sb/ip',
  },
  ipify: {
    label: 'ipify',
    ipv4: 'https://api.ipify.org',
    ipv6: 'https://api6.ipify.org',
  },
  'ident-me': {
    label: 'ident.me',
    ipv4: 'https://4.ident.me',
    ipv6: 'https://6.ident.me',
  },
} as const;
export type IpSource = keyof typeof IP_SOURCES;
export const IP_SOURCE_IDS = Object.keys(IP_SOURCES) as IpSource[];

export interface IpProbeResult {
  source: IpSource;
  family: 4 | 6;
  url: string;
  checkedAt: number;
  durationMs: number;
  status: 'ok' | 'warn';
  ip?: string;
  localAddress?: string;
  code?: string;
}

export function addressScope(address: string): string {
  return ipaddr.parse(address).range();
}

/** Conservative check on the exact DNS answer used by the socket, not a separate preflight lookup. */
export function isPublicAddress(address: string): boolean {
  return isIP(address) !== 0 && addressScope(address) === 'unicast';
}

@Injectable()
export class NetworkInspectionService {
  private readonly inflight = new Map<string, Promise<IpProbeResult>>();
  private readonly cache = new Map<string, IpProbeResult>();

  local() {
    return {
      checkedAt: Date.now(),
      // An image declaration only: do not infer Docker's engine, network mode or host addresses.
      runtime: process.env.SOMS_RUNTIME === 'docker' ? 'docker' : 'unknown',
      interfaces: Object.entries(networkInterfaces()).flatMap(
        ([name, entries]) =>
          (entries ?? []).map((entry) => ({
            name,
            address: entry.address,
            family: entry.family === 'IPv6' ? 6 : 4,
            cidr: entry.cidr,
            scope: entry.internal ? 'loopback' : addressScope(entry.address),
          })),
      ),
      sources: IP_SOURCE_IDS.map((id) => ({ id, ...IP_SOURCES[id] })),
    };
  }

  /** Bounded key space, single flight and a short cooldown prevent repeated clicks amplifying traffic. */
  probe(source: IpSource, family: 4 | 6): Promise<IpProbeResult> {
    if (!IP_SOURCE_IDS.includes(source) || (family !== 4 && family !== 6)) {
      throw new Error('Unsupported IP probe');
    }
    const key = `${source}:${family}`;
    const active = this.inflight.get(key);
    if (active) return active;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.checkedAt < 10_000)
      return Promise.resolve(cached);
    const pending = this.requestIp(source, family)
      .then((result) => {
        this.cache.set(key, result);
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  private requestIp(source: IpSource, family: 4 | 6): Promise<IpProbeResult> {
    const url = IP_SOURCES[source][family === 4 ? 'ipv4' : 'ipv6'];
    const checkedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      let localAddress: string | undefined;
      const finish = (
        result: Pick<IpProbeResult, 'status' | 'ip' | 'code'>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          source,
          family,
          url,
          checkedAt,
          durationMs: Date.now() - checkedAt,
          localAddress,
          ...result,
        });
      };
      // Wall-clock deadline covers DNS, connection, TLS and response consumption.
      const timer = setTimeout(() => {
        finish({ status: 'warn', code: 'ETIMEDOUT' });
        req.destroy();
      }, 5000);
      const req = request(
        url,
        {
          family,
          agent: false,
          headers: {
            'User-Agent': 'SOMS-Network-Inspection/1.0',
            Accept: 'text/plain',
          },
          lookup: (hostname, _options, callback) => {
            lookup(hostname, { family }, (error, address, resolvedFamily) => {
              if (error) return callback(error, address, resolvedFamily);
              if (!isPublicAddress(address)) {
                return callback(
                  Object.assign(new Error('Non-public destination'), {
                    code: 'NON_PUBLIC_DESTINATION',
                  }),
                  address,
                  resolvedFamily,
                );
              }
              callback(null, address, resolvedFamily);
            });
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            finish({ status: 'warn', code: `HTTP_${res.statusCode}` });
            res.destroy();
            req.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256) {
              finish({ status: 'warn', code: 'RESPONSE_TOO_LARGE' });
              res.destroy();
              req.destroy();
            } else chunks.push(chunk);
          });
          res.on('error', () =>
            finish({ status: 'warn', code: 'RESPONSE_ERROR' }),
          );
          res.on('end', () => {
            const ip = Buffer.concat(chunks).toString('utf8').trim();
            if (isIP(ip) !== family || !isPublicAddress(ip)) {
              finish({ status: 'warn', code: 'INVALID_IP_RESPONSE' });
            } else finish({ status: 'ok', ip });
          });
        },
      );
      req.on('socket', (socket) => {
        socket.on('connect', () => {
          localAddress = socket.localAddress;
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) =>
        finish({ status: 'warn', code: error.code ?? 'REQUEST_FAILED' }),
      );
      req.end();
    });
  }
}
