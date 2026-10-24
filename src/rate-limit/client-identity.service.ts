import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  resolveClientAddress,
  normalizeClientAddress,
  type NormalizedClientAddress,
} from './client-address.js';
import { parseTrustedProxyConfig } from './trusted-proxy.js';
import { backendSocketPath } from '../common/http-listener.js';

/** Request-facing adapter around the pure address parser. */
@Injectable()
export class ClientIdentityService {
  private readonly trustedProxyCidrs: readonly string[];
  private readonly unixListener = Boolean(backendSocketPath());

  constructor() {
    this.trustedProxyCidrs = parseTrustedProxyConfig(
      process.env.TRUSTED_PROXY_CIDRS,
    ).cidrs;
  }

  fromRequest(request: FastifyRequest): NormalizedClientAddress | undefined {
    if (this.unixListener) {
      // Caddy overwrites the forwarded client address. Only the nearest hop is authoritative.
      if (request.raw.socket.remoteAddress !== undefined) return undefined;
      const forwarded = request.headers['x-forwarded-for'];
      if (typeof forwarded !== 'string') return undefined;
      return normalizeClientAddress(forwarded.split(',').at(-1) ?? '');
    }
    return resolveClientAddress({
      remoteAddress: request.raw.socket.remoteAddress,
      forwardedFor: request.headers['x-forwarded-for'],
      trustedProxyCidrs: this.trustedProxyCidrs,
    });
  }
}
