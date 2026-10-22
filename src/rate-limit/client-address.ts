import ipaddr from 'ipaddr.js';

export type NormalizedClientAddress =
  | {
      family: 'ipv4';
      address: string;
      exactSubject: string;
    }
  | {
      family: 'ipv6';
      address: string;
      exactSubject: string;
      prefix64Subject: string;
    };

/**
 * Parse an address into one canonical identity. IPv4-mapped IPv6 is deliberately collapsed into
 * IPv4 so the same peer cannot acquire two rate-limit buckets by changing address notation.
 * Zone identifiers are rejected: they are meaningful only on the local host and are not a stable
 * identity for an Internet client.
 */
export function normalizeClientAddress(
  input: string,
): NormalizedClientAddress | undefined {
  const value = unwrapAddress(input.trim());
  if (!value || value.includes('%')) return undefined;

  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(value);
  } catch {
    return undefined;
  }

  if (
    parsed.kind() === 'ipv6' &&
    (parsed as ipaddr.IPv6).isIPv4MappedAddress()
  ) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }

  if (parsed.kind() === 'ipv4') {
    const address = parsed.toString();
    return {
      family: 'ipv4',
      address,
      exactSubject: `ip4:${address}`,
    };
  }

  const address = (parsed as ipaddr.IPv6).toRFC5952String();
  const prefix64 = ipaddr.IPv6.networkAddressFromCIDR(
    `${address}/64`,
  ).toRFC5952String();
  return {
    family: 'ipv6',
    address,
    exactSubject: `ip6:${address}`,
    prefix64Subject: `ip6-prefix64:${prefix64}/64`,
  };
}

export interface ClientAddressInput {
  /** Raw TCP peer. This is the only trusted value before proxy validation. */
  remoteAddress: string | undefined;
  /** X-Forwarded-For supplied by the immediate peer. */
  forwardedFor?: string | string[];
  /** Explicit proxy addresses/ranges; do not use a blanket trust-all setting. */
  trustedProxyCidrs: readonly string[];
}

/**
 * Resolve the client by walking X-Forwarded-For from the nearest hop outwards. Forwarded data is
 * ignored unless the raw TCP peer belongs to an explicitly trusted proxy range. A malformed chain
 * fails closed to the raw peer rather than accepting attacker-controlled fragments.
 */
export function resolveClientAddress(
  input: ClientAddressInput,
): NormalizedClientAddress | undefined {
  if (!input.remoteAddress) return undefined;
  const remote = normalizeClientAddress(input.remoteAddress);
  if (!remote) return undefined;

  const trustedRanges = parseTrustedRanges(input.trustedProxyCidrs);
  if (!isTrusted(remote.address, trustedRanges)) return remote;

  const rawForwarded = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(',')
    : input.forwardedFor;
  if (!rawForwarded) return remote;

  const forwarded = rawForwarded
    .split(',')
    .map((part) => normalizeClientAddress(part))
    .filter(
      (address): address is NormalizedClientAddress => address !== undefined,
    );
  if (forwarded.length !== rawForwarded.split(',').length) return remote;

  let candidate = remote;
  for (let i = forwarded.length - 1; i >= 0; i--) {
    if (!isTrusted(candidate.address, trustedRanges)) break;
    candidate = forwarded[i];
  }
  return candidate;
}

type TrustedRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseTrustedRanges(cidrs: readonly string[]): TrustedRange[] {
  return cidrs.map((cidr) => {
    try {
      return ipaddr.parseCIDR(cidr);
    } catch {
      throw new Error(`invalid trusted proxy CIDR: ${cidr}`);
    }
  });
}

function isTrusted(address: string, ranges: readonly TrustedRange[]): boolean {
  const parsed = ipaddr.parse(address);
  return ranges.some(([network, prefix]) => {
    if (parsed.kind() !== network.kind()) return false;
    return parsed.match(network, prefix);
  });
}

function unwrapAddress(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}
