import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  resolveClientAddress,
  type NormalizedClientAddress,
} from './client-address.js';
import { parseTrustedProxyConfig } from './trusted-proxy.js';

/** Request-facing adapter around the pure address parser. */
@Injectable()
export class ClientIdentityService {
  private readonly trustedProxyCidrs: readonly string[];

  constructor() {
    this.trustedProxyCidrs = parseTrustedProxyConfig(
      process.env.TRUSTED_PROXY_CIDRS,
    ).cidrs;
  }

  fromRequest(request: FastifyRequest): NormalizedClientAddress | undefined {
    return resolveClientAddress({
      remoteAddress: request.raw.socket.remoteAddress,
      forwardedFor: request.headers['x-forwarded-for'],
      trustedProxyCidrs: this.trustedProxyCidrs,
    });
  }
}
