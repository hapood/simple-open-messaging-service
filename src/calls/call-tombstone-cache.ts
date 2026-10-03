export type CallTombstoneOperation =
  | 'admitted'
  | 'declined'
  | 'cancelled'
  | 'missed'
  | 'ended';

export interface CallTombstoneEntry {
  terminalOp: CallTombstoneOperation;
  endReason: string | null;
  initialCallType: string;
  finalCallType: string;
  signalIds: ReadonlySet<string>;
  expiresAt: number;
  peerDomain: string | null;
}

/** Process-local protection for federated call retries and late frames. */
const MAX_ENTRIES = 4096;
const MAX_SIGNAL_IDS = 1024;
const MAX_RETENTION_MS = 5 * 60 * 1000;

class CallTombstoneCache {
  private readonly entries = new Map<string, CallTombstoneEntry>();

  clear(): void {
    this.entries.clear();
  }

  get(
    namespaceId: number,
    callSid: string,
    peerDomain?: string,
  ): CallTombstoneEntry | undefined {
    const key = this.key(namespaceId, callSid);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (peerDomain !== undefined && entry.peerDomain !== peerDomain)
      return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  admit(params: {
    namespaceId: number;
    callSid: string;
    initialCallType: string;
    finalCallType: string;
    expiresAt: number;
    peerDomain: string;
  }): boolean {
    this.pruneExpired();
    const key = this.key(params.namespaceId, params.callSid);
    if (this.entries.has(key)) return false;
    this.entries.set(key, {
      terminalOp: 'admitted',
      endReason: null,
      initialCallType: params.initialCallType,
      finalCallType: params.finalCallType,
      signalIds: new Set(),
      expiresAt: this.boundExpiry(params.expiresAt),
      peerDomain: params.peerDomain,
    });
    this.enforceCapacity();
    return true;
  }

  /** Record an early cancellation unless a terminal decision already exists. */
  cancelEarly(params: {
    namespaceId: number;
    callSid: string;
    expiresAt: number;
    peerDomain: string;
  }): void {
    this.pruneExpired();
    const key = this.key(params.namespaceId, params.callSid);
    const prior = this.entries.get(key);
    if (prior && prior.peerDomain !== params.peerDomain) return;
    if (prior && prior.terminalOp !== 'admitted') return;
    this.entries.set(key, {
      terminalOp: 'cancelled',
      endReason: null,
      initialCallType: prior?.initialCallType ?? 'UNKNOWN',
      finalCallType: prior?.finalCallType ?? 'UNKNOWN',
      signalIds: new Set(),
      expiresAt: this.boundExpiry(params.expiresAt),
      peerDomain: params.peerDomain,
    });
    this.enforceCapacity();
  }

  /** Persist the first terminal decision for the lifetime of this process. */
  finish(params: {
    namespaceId: number;
    callSid: string;
    terminalOp: Exclude<CallTombstoneOperation, 'admitted'>;
    endReason: string | null;
    initialCallType: string;
    finalCallType: string;
    signalIds: Iterable<string>;
    expiresAt: number;
    peerDomain: string;
  }): void {
    this.pruneExpired();
    const key = this.key(params.namespaceId, params.callSid);
    const prior = this.entries.get(key);
    if (prior && prior.peerDomain !== params.peerDomain) return;
    if (prior && prior.terminalOp !== 'admitted') return;
    this.entries.set(key, {
      terminalOp: params.terminalOp,
      endReason: params.endReason,
      initialCallType: prior?.initialCallType ?? params.initialCallType,
      finalCallType: params.finalCallType,
      signalIds: this.limitSignalIds(params.signalIds),
      expiresAt: this.boundExpiry(params.expiresAt),
      peerDomain: params.peerDomain,
    });
    this.enforceCapacity();
  }

  private key(namespaceId: number, callSid: string): string {
    return JSON.stringify([namespaceId, callSid]);
  }

  private limitSignalIds(signalIds: Iterable<string>): ReadonlySet<string> {
    const limited = new Set<string>();
    for (const signalId of signalIds) {
      limited.add(signalId);
      if (limited.size >= MAX_SIGNAL_IDS) break;
    }
    return limited;
  }

  private boundExpiry(expiresAt: number): number {
    return Math.min(expiresAt, Date.now() + MAX_RETENTION_MS);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private enforceCapacity(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    let oldestKey: string | undefined;
    let oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < oldestExpiry) {
        oldestKey = key;
        oldestExpiry = entry.expiresAt;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}

export const callTombstoneCache = new CallTombstoneCache();
