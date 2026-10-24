import type { SrvRecord } from 'node:dns';

/**
 * Classification of a `_somfp._tcp` SRV RRset. Shared by outbound discovery and the admin
 * self-check so the two can never disagree about which record sets are usable.
 */

/** SRV target grammar: a DNS hostname, never an IPv4/IPv6 literal or another direct IP notation. */
const SRV_HOSTNAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

/** Decimal IPv4, bracketed or bare IPv6, and any other colon notation are direct IP representations. */
function isIpLiteral(name: string): boolean {
  return (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) ||
    name.includes(':') ||
    (name.startsWith('[') && name.endsWith(']'))
  );
}

/** One normalized SRV record; `host` is the lower-cased, dot-trimmed target. */
export interface SomfpSrvRecord {
  priority: number;
  weight: number;
  port: number;
  host: string;
  /** `priority weight port name` exactly as published. */
  display: string;
}

/** A deduplicated connectable endpoint shared by one or more SRV records. */
export interface SomfpSrvTarget {
  host: string;
  port: number;
}

export type SomfpSrvRrset =
  | { kind: 'empty' }
  /** Sole `.` target: the domain explicitly publishes no SOMFP service. */
  | { kind: 'disabled' }
  /** `.` mixed with other targets, or a record violating the field grammar. */
  | { kind: 'invalid'; reason: 'mixed' | 'fields' }
  | { kind: 'targets'; records: SomfpSrvRecord[]; targets: SomfpSrvTarget[] };

/** Select the lowest-priority group, then apply the outbound transport's weight policy. */
export function selectSomfpSrvRecord(
  records: readonly SomfpSrvRecord[],
  random: () => number = Math.random,
): SomfpSrvRecord {
  if (!records.length) throw new Error('No SOMFP SRV targets');
  const priority = Math.min(...records.map((record) => record.priority));
  const candidates = records.filter((record) => record.priority === priority);
  const total = candidates.reduce((sum, record) => sum + record.weight, 0);
  if (total === 0) return candidates[Math.floor(random() * candidates.length)]!;
  let selected = random() * total;
  for (const record of candidates) {
    selected -= record.weight;
    if (selected < 0) return record;
  }
  return candidates[candidates.length - 1]!;
}

export function classifySomfpSrvRrset(records: SrvRecord[]): SomfpSrvRrset {
  if (records.length === 0) return { kind: 'empty' };
  if (records.some((record) => record.name === '.')) {
    if (records.length === 1) return { kind: 'disabled' };
    return { kind: 'invalid', reason: 'mixed' };
  }
  const valid = records.filter(
    (record) =>
      !isIpLiteral(record.name.replace(/\.+$/, '').toLowerCase()) &&
      SRV_HOSTNAME_RE.test(record.name.replace(/\.+$/, '').toLowerCase()) &&
      record.port >= 1 &&
      record.port <= 65_535 &&
      record.priority >= 0 &&
      record.priority <= 65_535 &&
      record.weight >= 0 &&
      record.weight <= 65_535,
  );
  if (valid.length !== records.length)
    return { kind: 'invalid', reason: 'fields' };
  const normalized: SomfpSrvRecord[] = valid.map((record) => ({
    priority: record.priority,
    weight: record.weight,
    port: record.port,
    host: record.name.replace(/\.+$/, '').toLowerCase(),
    display: `${record.priority} ${record.weight} ${record.port} ${record.name}`,
  }));
  const targets: SomfpSrvTarget[] = [];
  for (const record of normalized) {
    if (!targets.some((t) => t.host === record.host && t.port === record.port))
      targets.push({ host: record.host, port: record.port });
  }
  return { kind: 'targets', records: normalized, targets };
}
