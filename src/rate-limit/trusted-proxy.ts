import ipaddr from 'ipaddr.js';
import { normalizeClientAddress } from './client-address.js';

type TrustedRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

export interface TrustedProxyConfig {
  readonly cidrs: readonly string[];
  readonly trustAllCidrs: readonly string[];
  readonly isTrusted: (address: string) => boolean;
}

/**
 * Build the single proxy trust policy shared by Fastify and application guards.
 * Missing and explicitly empty values both mean "trust no proxy".
 */
export function parseTrustedProxyConfig(
  value: string | undefined,
): TrustedProxyConfig {
  const cidrs = (value ?? '')
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  const ranges = cidrs.map(parseTrustedRange);

  return {
    cidrs,
    trustAllCidrs: cidrs.filter((_, index) => ranges[index][1] === 0),
    isTrusted: (address: string) => isAddressTrusted(address, ranges),
  };
}

function parseTrustedRange(cidr: string): TrustedRange {
  try {
    return ipaddr.parseCIDR(cidr);
  } catch {
    throw new Error(`invalid TRUSTED_PROXY_CIDRS entry: ${cidr}`);
  }
}

function isAddressTrusted(
  address: string,
  ranges: readonly TrustedRange[],
): boolean {
  const normalized = normalizeClientAddress(address);
  if (!normalized) return false;
  const parsed = ipaddr.parse(normalized.address);
  return ranges.some(([network, prefix]) => {
    if (parsed.kind() !== network.kind()) return false;
    return parsed.match(network, prefix);
  });
}
