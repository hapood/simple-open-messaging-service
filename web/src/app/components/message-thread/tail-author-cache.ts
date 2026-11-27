import type { ThreadAuthor } from '../../../../../shared/thread-author';

export const TAIL_AUTHOR_CACHE_LIMIT = 100;
export const TAIL_OVERLAP_AVATAR_LIMIT = 3;
const SYSTEM_ACCOUNT = '$system';

export interface TailAuthorProjection {
  readonly hasPendingSelf: boolean;
  readonly hasPendingPeer: boolean;
  /** Oldest observed unconsumed non-self author; supplies the normal grouped peer avatar. */
  readonly primaryPeer: ThreadAuthor | null;
  /** Additional deduplicated group peers (max 3), ordered by earliest pending seq. */
  readonly overlapPeers: readonly ThreadAuthor[];
  /** True when more than 3 additional peer identities exist; render `…`, never `+N`. */
  readonly hasOverflow: boolean;
}

function authorKey(author: ThreadAuthor): string {
  return `${author.namespaceId}\0${author.account}`;
}

function sameAuthor(a: ThreadAuthor, b: ThreadAuthor): boolean {
  return a.namespaceId === b.namespaceId && a.account === b.account;
}

function trimOldest(entries: Map<number, ThreadAuthor>, limit: number): void {
  if (entries.size <= limit) return;
  const sorted = [...entries.keys()].sort((a, b) => a - b);
  const excess = entries.size - limit;
  for (let i = 0; i < excess; i++) entries.delete(sorted[i]);
}

/**
 * Ephemeral chatbox-scoped cache of observed pending head authors.
 *
 * Dot completion is an interval-end latch, independent of the bounded identity
 * metadata maps. Eviction and individual mounted messages never hide pending
 * work. Only successful interval scans can complete the current gap.
 */
export class TailAuthorCache {
  private readonly selfEntries = new Map<number, ThreadAuthor>();
  private readonly peerEntries = new Map<number, ThreadAuthor>();
  private selfEnd: number | null = null;
  private sendFloor = 0;
  private peerEnd: number | null = null;
  private completedThrough = 0;
  private scopeGeneration = 0;
  private sending = new Set<string>();

  /** A new local send opens a gap before its server head is known. Count changes
   * (including POST completion) never close it or reopen a fetched generation. */
  observeSending(ids: readonly string[], knownEnd: number): boolean {
    const next = new Set(ids);
    const started = ids.some((id) => !this.sending.has(id));
    this.sending = next;
    if (!started) return false;
    // A head may have arrived before Angular runs the task effect. Reuse that
    // observed gap rather than inventing a sequence beyond the server head.
    this.selfEnd ??= Number.POSITIVE_INFINITY;
    this.sendFloor = knownEnd;
    return true;
  }

  /** Capture the chat scope, not the subscription's send snapshot. Long-lived
   * interval consumers may fetch newer gaps; each delivery checks the current end. */
  captureGeneration(): number {
    return this.scopeGeneration;
  }

  constructor(
    private readonly self: ThreadAuthor | (() => ThreadAuthor | null),
    private readonly isGroup: boolean | (() => boolean),
  ) {}

  /** Record one observed head author. Ignores zero heads and `$system`. */
  observe(seq: number, author: ThreadAuthor | undefined): boolean {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq <= this.completedThrough)
      return false;
    const previousSelfEnd = this.selfEnd;
    if (this.selfEnd === Number.POSITIVE_INFINITY && seq > this.sendFloor)
      this.selfEnd = seq;
    else if (this.selfEnd !== null) this.selfEnd = Math.max(this.selfEnd, seq);
    if (!author || author.account === SYSTEM_ACCOUNT)
      return this.selfEnd !== previousSelfEnd;
    const currentSelf = typeof this.self === 'function' ? this.self() : this.self;
    const isSelf = currentSelf !== null && sameAuthor(author, currentSelf);
    if (isSelf) this.selfEnd = Math.max(this.selfEnd ?? 0, seq);
    else this.peerEnd = Math.max(this.peerEnd ?? 0, seq);
    const target = isSelf ? this.selfEntries : this.peerEntries;
    const other = isSelf ? this.peerEntries : this.selfEntries;
    other.delete(seq);
    const existing = target.get(seq);
    if (existing && sameAuthor(existing, author)) return false;
    target.set(seq, { account: author.account, namespaceId: author.namespaceId });
    trimOldest(target, TAIL_AUTHOR_CACHE_LIMIT);
    return true;
  }

  /** Only a successful latest scan covering the current gap endpoint completes
   * the dots. Bodies, deletions and server gaps inside that scan are immaterial.
   * A superseded chat scope cannot complete a successor's gap. Long-lived
   * consumers remain valid only when their actual result covers today's end. */
  consumeCoveredInterval(
    left: number,
    right: number,
    generation = this.scopeGeneration,
  ): boolean {
    if (generation !== this.scopeGeneration || !Number.isSafeInteger(left) ||
        !Number.isSafeInteger(right) || left >= right)
      return false;
    let changed = false;
    this.completedThrough = Math.max(this.completedThrough, right);
    const coversSelf = this.selfEnd === Number.POSITIVE_INFINITY
      ? right > this.sendFloor
      : this.selfEnd !== null && left < this.selfEnd && right >= this.selfEnd;
    if (coversSelf) {
      this.selfEnd = null;
      changed = true;
    }
    if (this.peerEnd !== null && left < this.peerEnd && right >= this.peerEnd) {
      this.peerEnd = null;
      changed = true;
    }
    for (const map of [this.selfEntries, this.peerEntries]) {
      for (const seq of map.keys()) {
        if (seq > left && seq <= right) {
          map.delete(seq);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Release all ephemeral state on window teardown / scope revocation. */
  clear(): void {
    this.selfEntries.clear();
    this.peerEntries.clear();
    this.selfEnd = null;
    this.peerEnd = null;
    this.completedThrough = 0;
    this.sending.clear();
    this.scopeGeneration++;
  }

  get selfCount(): number {
    return this.selfEntries.size;
  }

  get peerCount(): number {
    return this.peerEntries.size;
  }

  project(): TailAuthorProjection {
    const hasPendingSelf = this.selfEnd !== null;
    const hasPendingPeer = this.peerEnd !== null;
    if (!hasPendingPeer) {
      return {
        hasPendingSelf,
        hasPendingPeer: false,
        primaryPeer: null,
        overlapPeers: [],
        hasOverflow: false,
      };
    }

    const orderedPeers = [...this.peerEntries.entries()].sort(
      (a, b) => a[0] - b[0],
    );
    const primaryPeer = orderedPeers[0]?.[1] ?? null;
    const groupMode =
      typeof this.isGroup === 'function' ? this.isGroup() : this.isGroup;
    if (!groupMode) {
      return {
        hasPendingSelf,
        hasPendingPeer: true,
        primaryPeer,
        overlapPeers: [],
        hasOverflow: false,
      };
    }

    const seen = new Set<string>(primaryPeer ? [authorKey(primaryPeer)] : []);
    const overlapPeers: ThreadAuthor[] = [];
    let hasOverflow = false;
    for (let i = 1; i < orderedPeers.length; i++) {
      const candidate = orderedPeers[i][1];
      const key = authorKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      if (overlapPeers.length < TAIL_OVERLAP_AVATAR_LIMIT) {
        overlapPeers.push(candidate);
      } else {
        hasOverflow = true;
        break;
      }
    }

    return {
      hasPendingSelf,
      hasPendingPeer: true,
      primaryPeer,
      overlapPeers,
      hasOverflow,
    };
  }
}
