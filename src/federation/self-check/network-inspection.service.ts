import { Injectable } from '@nestjs/common';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function addressScope(address: string): string {
  return ipaddr.parse(address).range();
}

/** Only globally routable unicast destinations may be dialed by public diagnostics. */
export function isPublicAddress(address: string): boolean {
  return isIP(address) !== 0 && addressScope(address) === 'unicast';
}

/** Process-local interface facts, without active probes or host-network assumptions. */
@Injectable()
export class NetworkInspectionService {
  local() {
    return {
      checkedAt: Date.now(),
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
    };
  }
}
